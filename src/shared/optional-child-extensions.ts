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
	return error instanceof Error ? error.message : String(error);
}

/**
 * Select this host's optional extensions for one child.
 *
 * `loadedPaths` are the extension paths the child already loads; an optional
 * entry whose canonical path matches one of them, or an earlier entry, is
 * dropped so the same file never loads twice. Never throws.
 */
export function resolveOptionalChildExtensions(host: string, loadedPaths: readonly string[] = [], cwd: string = process.cwd()): OptionalChildExtensionResolution {
	let registry: unknown;
	try {
		registry = (globalThis as Record<PropertyKey, unknown>)[OPTIONAL_CHILD_EXTENSIONS_KEY];
	} catch (error) {
		return { extensions: [], diagnostics: [`optional child extension registry is unreadable: ${describe(error)}`] };
	}
	if (registry === undefined) return EMPTY_RESOLUTION;
	if (!(registry instanceof Map)) return { extensions: [], diagnostics: ["optional child extension registry ignored: it is not a Map"] };

	const seen = new Set<string>();
	for (const loaded of loadedPaths) {
		if (typeof loaded === "string" && loaded && isLocalExtensionSpec(loaded)) seen.add(canonicalPath(loaded, cwd));
	}
	const extensions: OptionalChildExtension[] = [];
	const diagnostics: string[] = [];
	let entries: Array<[unknown, unknown]>;
	try {
		entries = [...registry.entries()];
	} catch (error) {
		return { extensions: [], diagnostics: [`optional child extension registry is unreadable: ${describe(error)}`] };
	}
	for (const [key, entry] of entries) {
		const id = String(key);
		try {
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

/** Minimal view of a pi `Extension` this module touches. */
interface LoadedExtensionLike {
	path: string;
	resolvedPath?: string;
	handlers: Map<string, Array<(...args: never[]) => unknown>>;
}

/**
 * Make an optional extension's event handlers unable to affect the child: a
 * handler that throws or rejects is reported and treated as returning nothing.
 * Pi already isolates most handler errors, but not all (a throwing `tool_call`
 * handler fails the tool call), and an observer must never change the run.
 * Handlers that succeed keep their return value and their sync/async shape.
 */
export function isolateOptionalExtensionHandlers(extension: LoadedExtensionLike, report: (event: string, error: unknown) => void): void {
	for (const [event, handlers] of extension.handlers) {
		extension.handlers.set(event, handlers.map((handler) => {
			const isolated = (...args: never[]): unknown => {
				try {
					const result = handler(...args);
					if (result && typeof (result as PromiseLike<unknown>).then === "function") {
						return Promise.resolve(result).catch((error: unknown) => {
							report(event, error);
							return undefined;
						});
					}
					return result;
				} catch (error) {
					report(event, error);
					return undefined;
				}
			};
			return isolated;
		}));
	}
}
