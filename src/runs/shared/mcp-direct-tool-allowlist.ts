import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { ResolvedMcpDirectToolSelection } from "./mcp-direct-tool-grant.ts";
export type { ResolvedMcpDirectToolSelection } from "./mcp-direct-tool-grant.ts";
export { formatUnresolvedMcpDirectToolSelectors } from "./mcp-direct-tool-grant.ts";

/** Kept as an input type for callers; native server discovery belongs to the child. */
export type McpRuntimeSnapshotHost = Pick<ExtensionAPI, "events">;
export interface McpDirectToolResolution {
	selections: ResolvedMcpDirectToolSelection[];
	unresolvedSelectors: string[];
}

/** Pi's native name algorithm, including the 64-character provider limit. */
export function nativeMcpToolName(server: string, tool: string): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
	if (name.length <= 64) return name;
	const hash = createHash("sha256")
		.update(`${server}\0${tool}`)
		.digest("hex")
		.slice(0, 8);
	return `${name.slice(0, 55)}_${hash}`;
}

/** A whole-server grant is expanded only against the child's trusted live registry. */
export function childToolNameMatches(grant: string, name: string): boolean {
	return grant.endsWith("__*")
		? name.startsWith(grant.slice(0, -1))
		: grant === name;
}

export function resolveMcpDirectToolResolution(
	selectors: string[] | undefined,
	_cwd?: string,
	_host?: McpRuntimeSnapshotHost,
): McpDirectToolResolution {
	const selections: ResolvedMcpDirectToolSelection[] = [];
	const unresolvedSelectors: string[] = [];
	for (const selector of new Set(
		(selectors ?? []).map((s) => s.replace(/\/+$/, "")),
	)) {
		const [server, tool, extra] = selector.split("/");
		if (
			!server ||
			!/^[A-Za-z0-9_-]+$/.test(server) ||
			extra !== undefined ||
			(selector.includes("/") && !tool)
		) {
			unresolvedSelectors.push(selector);
			continue;
		}
		selections.push({
			name: tool ? nativeMcpToolName(server, tool) : `mcp__${server}__*`,
			selector,
		});
	}
	return { selections, unresolvedSelectors };
}
export function resolveMcpDirectToolSelections(
	selectors: string[] | undefined,
	cwd?: string,
	host?: McpRuntimeSnapshotHost,
): ResolvedMcpDirectToolSelection[] {
	return resolveMcpDirectToolResolution(selectors, cwd, host).selections;
}
export function resolveMcpDirectToolNames(
	selectors: string[] | undefined,
	cwd?: string,
): string[] {
	return resolveMcpDirectToolSelections(selectors, cwd).map((s) => s.name);
}
