/**
 * Optional child extensions: a cross-package, fail-open registry of observer
 * extensions that a host adds to every child session it creates.
 *
 * The convention is shared with pi-dynamic-workflows and owned by neither
 * package, so it lives on `globalThis` under a `Symbol.for` key that any
 * extension can reach without importing this module:
 *
 *   globalThis[Symbol.for("pi.optional-child-extensions.v1")]
 *     = Map<id, { paths?: { [host]: absolutePath }, path?: absolutePath }>
 *
 * Whoever registers first creates the Map. A host loads `paths[host] ?? path`
 * of every entry into each child it creates, after capability ceilings,
 * `denyExtensions`, and `extensions: []` were applied: entries are observers
 * (metrics, recording), not capabilities, so a ceiling does not remove them.
 *
 * Unlike the required-extension registry (required-child-extensions.ts), which
 * fails closed, nothing about an optional entry can fail a launch. A malformed
 * registry, a malformed entry, a relative or missing path, a load error, and a
 * throwing handler all become diagnostics only.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const OPTIONAL_CHILD_EXTENSIONS_KEY = Symbol.for("pi.optional-child-extensions.v1");

/** This package's host name in the registry's per-host `paths`. */
export const PI_SUBAGENTS_OPTIONAL_HOST = "pi-subagents";

/** One registry value. `paths[host]` wins over `path` for that host. */
export interface OptionalChildExtensionEntry {
	paths?: Record<string, string>;
	path?: string;
}

export interface OptionalChildExtension {
	/** The registry key, for diagnostics. */
	id: string;
	/** The absolute path the entry named; this is the path the loader imports. */
	path: string;
	/** Its canonical path, used for deduplication and for matching loader results. */
	realPath: string;
}

export interface OptionalChildExtensionResolution {
	extensions: OptionalChildExtension[];
	/** Human-readable reasons an entry was skipped. Never fatal. */
	diagnostics: string[];
}

const EMPTY_RESOLUTION: OptionalChildExtensionResolution = Object.freeze({ extensions: [], diagnostics: [] }) as OptionalChildExtensionResolution;

/** Path specs that are not local files: pi builtins, inline factories, packages. */
function isLocalExtensionSpec(spec: string): boolean {
	return !spec.startsWith("builtin:") && !spec.startsWith("<") && !/^(?:npm|git|https?|ssh):/.test(spec);
}

function canonicalPath(spec: string, cwd: string): string {
	const absolute = path.resolve(cwd, spec);
	try {
		return fs.realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function describe(error: unknown): string {
	// A thrown value can be anything, including a null-prototype object that
	// String() cannot convert, so describing it must not throw either.
	try {
		const text: unknown = error instanceof Error ? error.message : error;
		return typeof text === "string" ? text : String(text);
	} catch {
		return "<unprintable error>";
	}
}

/** A registry key as text. Keys can be anything a Map holds, including null-prototype objects. */
function describeKey(key: unknown): string {
	try {
		return typeof key === "symbol" ? key.toString() : String(key);
	} catch {
		return "<unprintable key>";
	}
}

function unreadable(error: unknown): OptionalChildExtensionResolution {
	return { extensions: [], diagnostics: [`optional child extension registry is unreadable: ${describe(error)}`] };
}

/**
 * Select this host's optional extensions for one child.
 *
 * `loadedPaths` are the extension paths the child already loads; an optional
 * entry whose canonical path matches one of them, or an earlier entry, is
 * dropped so the same file never loads twice. Never throws: whatever another
 * extension put in the registry, the worst outcome is a diagnostic.
 */
export function resolveOptionalChildExtensions(host: string, loadedPaths: readonly string[] = [], cwd: string = process.cwd()): OptionalChildExtensionResolution {
	try {
		return resolveFromRegistry(host, loadedPaths, cwd);
	} catch (error) {
		return unreadable(error);
	}
}

function resolveFromRegistry(host: string, loadedPaths: readonly string[], cwd: string): OptionalChildExtensionResolution {
	let registry: unknown;
	try {
		registry = (globalThis as Record<PropertyKey, unknown>)[OPTIONAL_CHILD_EXTENSIONS_KEY];
	} catch (error) {
		return unreadable(error);
	}
	if (registry === undefined) return EMPTY_RESOLUTION;
	let isMap: boolean;
	try {
		// A Proxy registry can throw from its getPrototypeOf trap.
		isMap = registry instanceof Map;
	} catch (error) {
		return unreadable(error);
	}
	if (!isMap) return { extensions: [], diagnostics: ["optional child extension registry ignored: it is not a Map"] };

	const seen = new Set<string>();
	for (const loaded of loadedPaths) {
		if (typeof loaded === "string" && loaded && isLocalExtensionSpec(loaded)) seen.add(canonicalPath(loaded, cwd));
	}
	const extensions: OptionalChildExtension[] = [];
	const diagnostics: string[] = [];
	let entries: unknown[];
	try {
		entries = [...(registry as Map<unknown, unknown>).entries()];
	} catch (error) {
		return unreadable(error);
	}
	for (const item of entries) {
		let id = "<unknown key>";
		try {
			const [key, entry] = item as [unknown, unknown];
			id = describeKey(key);
			if (!entry || typeof entry !== "object") {
				diagnostics.push(`optional child extension '${id}' ignored: its entry is not an object`);
				continue;
			}
			const { paths, path: fallback } = entry as OptionalChildExtensionEntry;
			const hostPath = paths && typeof paths === "object" ? paths[host] : undefined;
			const selected = hostPath ?? fallback;
			// An entry that names other hosts only is not for this host.
			if (selected === undefined) continue;
			if (typeof selected !== "string" || !selected || selected.includes("\0")) {
				diagnostics.push(`optional child extension '${id}' ignored: its path for '${host}' is not a non-empty string`);
				continue;
			}
			if (!path.isAbsolute(selected)) {
				diagnostics.push(`optional child extension '${id}' ignored: '${selected}' is not an absolute path`);
				continue;
			}
			let realPath: string;
			try {
				realPath = fs.realpathSync(selected);
				if (!fs.statSync(realPath).isFile()) throw new Error("not a file");
			} catch (error) {
				diagnostics.push(`optional child extension '${id}' not loaded: '${selected}' is not a readable file (${describe(error)})`);
				continue;
			}
			if (seen.has(realPath)) continue;
			seen.add(realPath);
			extensions.push({ id, path: selected, realPath });
		} catch (error) {
			diagnostics.push(`optional child extension '${id}' ignored: ${describe(error)}`);
		}
	}
	return { extensions, diagnostics };
}

type Handler = (...args: never[]) => unknown;

/** Minimal view of a pi `Extension` this module touches. */
interface LoadedExtensionLike {
	path: string;
	resolvedPath?: string;
	handlers: Map<string, Handler[]>;
}

/** Handler maps already isolated, so isolating twice is a no-op. */
const isolatedHandlerMaps = new WeakSet<object>();

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

function isolatedHandler(event: string, handler: Handler, report: (event: string, error: unknown) => void): Handler {
	const fail = (error: unknown): undefined => {
		try {
			report(event, error);
		} catch {
			// A broken reporter must not turn a contained error back into a thrown one.
		}
		return undefined;
	};
	return (...args: never[]): unknown => {
		try {
			const result = handler(...args);
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				return Promise.resolve(result).catch(fail);
			}
			return result;
		} catch (error) {
			return fail(error);
		}
	};
}

/**
 * Make an optional extension's event handlers unable to affect the child: a
 * handler that throws or rejects is reported and treated as returning nothing.
 * Pi already isolates most handler errors, but not all (a throwing `tool_call`
 * handler fails the tool call), and an observer must never change the run.
 * Handlers that succeed keep their return value and their sync/async shape.
 *
 * The wrapping happens when a handler is read, not once up front, so it also
 * covers handlers the extension registers later through `pi.on` (from
 * `session_start`, say). The map keeps pi's own handler arrays and the
 * original handlers in them: reads go through a view that hands out one
 * memoized wrapper per original, and writes through that view store the
 * original again. So pi's `on()` (`get`, `push`, `set`) and the unsubscribe
 * it returns (`get`, `indexOf`, `splice`, `delete`) keep working unchanged.
 */
export function isolateOptionalExtensionHandlers(extension: LoadedExtensionLike, report: (event: string, error: unknown) => void): void {
	const map = extension.handlers;
	if (!(map instanceof Map) || isolatedHandlerMaps.has(map)) return;
	isolatedHandlerMaps.add(map);

	const wrappersByEvent = new Map<string, WeakMap<Handler, Handler>>();
	const originals = new WeakMap<Handler, Handler>();
	const viewsByEvent = new Map<string, WeakMap<Handler[], Handler[]>>();
	const rawArrays = new WeakMap<object, Handler[]>();

	const unwrap = (value: unknown): unknown => (typeof value === "function" ? (originals.get(value as Handler) ?? value) : value);
	const wrap = (event: string, value: unknown): unknown => {
		if (typeof value !== "function" || originals.has(value as Handler)) return value;
		let wrappers = wrappersByEvent.get(event);
		if (!wrappers) {
			wrappers = new WeakMap();
			wrappersByEvent.set(event, wrappers);
		}
		let wrapper = wrappers.get(value as Handler);
		if (!wrapper) {
			wrapper = isolatedHandler(event, value as Handler, report);
			wrappers.set(value as Handler, wrapper);
			originals.set(wrapper, value as Handler);
		}
		return wrapper;
	};
	const viewOf = (key: unknown, raw: unknown): unknown => {
		if (!Array.isArray(raw)) return raw;
		const event = String(key);
		// A frozen array cannot be proxied with different element values; it
		// cannot be added to either, so a wrapped copy is equivalent.
		if (Object.isFrozen(raw)) return raw.map((handler) => wrap(event, handler));
		let views = viewsByEvent.get(event);
		if (!views) {
			views = new WeakMap();
			viewsByEvent.set(event, views);
		}
		let view = views.get(raw);
		if (!view) {
			view = new Proxy(raw as Handler[], {
				get(target, property, receiver) {
					if (typeof property === "string" && ARRAY_INDEX.test(property)) return wrap(event, target[Number(property)]);
					if (property === "indexOf" || property === "lastIndexOf" || property === "includes") {
						const search = target[property] as (value: unknown, ...rest: unknown[]) => unknown;
						return (value: unknown, ...rest: unknown[]) => search.call(target, unwrap(value), ...rest);
					}
					return Reflect.get(target, property, receiver);
				},
				set(target, property, value) {
					return Reflect.set(target, property, unwrap(value));
				},
				defineProperty(target, property, descriptor) {
					return Reflect.defineProperty(target, property, "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value) } : descriptor);
				},
			});
			views.set(raw, view);
			rawArrays.set(view, raw);
		}
		return view;
	};
	const toRaw = (value: unknown): unknown => {
		const raw = rawArrays.get(value as object);
		if (raw) return raw;
		if (Array.isArray(value) && !Object.isFrozen(value)) {
			for (let index = 0; index < value.length; index++) value[index] = unwrap(value[index]);
		}
		return value;
	};

	const { get, set, entries } = Map.prototype;
	function* viewEntries(): IterableIterator<[string, Handler[]]> {
		for (const [key, value] of entries.call(map) as IterableIterator<[string, Handler[]]>) {
			yield [key, viewOf(key, value) as Handler[]];
		}
	}
	function* viewValues(): IterableIterator<Handler[]> {
		for (const [, value] of viewEntries()) yield value;
	}
	const method = (value: unknown): PropertyDescriptor => ({ configurable: true, writable: true, value });
	Object.defineProperties(map, {
		get: method((key: string) => viewOf(key, get.call(map, key))),
		set: method((key: string, value: Handler[]) => {
			set.call(map, key, toRaw(value));
			return map;
		}),
		entries: method(viewEntries),
		[Symbol.iterator]: method(viewEntries),
		values: method(viewValues),
		forEach: method((callback: (value: Handler[], key: string, owner: Map<string, Handler[]>) => void, thisArg?: unknown) => {
			for (const [key, value] of viewEntries()) callback.call(thisArg, value, key, map);
		}),
	});
}
