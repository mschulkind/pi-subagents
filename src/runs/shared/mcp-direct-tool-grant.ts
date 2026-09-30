export interface ResolvedMcpDirectToolSelection {
	name: string;
	selector: string;
}

export function formatUnresolvedMcpDirectToolSelectors(
	selectors: readonly string[],
): string {
	return `Unresolved MCP direct-tool selectors: ${selectors.join(", ")}. Use server or server/tool selectors with native MCP server names. Availability is verified against the child's trusted live registry.`;
}
