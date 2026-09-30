export interface ChildToolDiagnostic {
	agent?: string;
	required: string[];
	available: string[];
	missing: string[];
	missingMcpDirectTools?: string[];
}

/**
 * Explain missing child tools. Foreground children run inside the parent
 * process and never load the parent's ambient extensions, so tools an ambient
 * extension registers (MCP tools, provider tools) only exist for background
 * children; the diagnostic says so instead of reporting a generic gap.
 */
export function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic, options: { host?: "parent" | "runner" } = {}): string {
	const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : "Subagent";
	if (options.host === "parent") {
		return [
			`${subject} ran as a foreground child, which never loads the parent's ambient extensions, and these child tools were unavailable: ${diagnostic.missing.join(", ")}.`,
			"The `tools` field is a strict allowlist; it does not load extension code.",
			...(diagnostic.missingMcpDirectTools?.length
				? [`MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}.`]
				: []),
			"Native MCP works in foreground and background children; check trusted mcp.json configuration and native tool names.",
			"Agents that rely on ambient extension tools must run as background children (`async: true`), or load the provider explicitly for the foreground child.",
			"For extension tools a foreground child can load, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		].join("\n");
	}
	return [
		`${subject} requested unavailable child tools: ${diagnostic.missing.join(", ")}.`,
		"The `tools` field is a strict allowlist; it does not load extension code.",
		...(diagnostic.missingMcpDirectTools?.length
			? [`Resolved MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(", ")}. Resolved names must match what the native MCP registers; check the MCP direct-tool registration before treating this as a tool-call failure.`]
			: []),
		"For extension tools, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.",
		"For MCP tools, verify the native MCP configuration and selected tool names. For builtin tools, verify the name against the installed Pi version.",
	].join("\n");
}
