import type {
	ExtensionAPI,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type {
	ChildSessionLaunch,
	PiCodingAgentModule,
} from "./child-session.ts";
import { childToolNameMatches } from "./mcp-direct-tool-allowlist.ts";

/** Native factories need builtin identity for the privileged MCP registry API.
 * Keep Pi's configuration/trust loader intact. Explicit grants never turn a
 * configured hidden tool into a callable tool, and discovery cannot bypass them.
 */
export function nativeChildExtensions(
	pi: PiCodingAgentModule,
	launch: ChildSessionLaunch,
): InlineExtension[] {
	const allowed = (name: string) =>
		(!launch.tools ||
			launch.tools.some((grant) => childToolNameMatches(grant, name))) &&
		!launch.excludeTools?.includes(name);
	const factories: InlineExtension[] = [];
	const ceiling: InlineExtension[] = [];
	if (launch.tools || launch.excludeTools?.length)
		ceiling.push({
			name: "pi-subagents:tool-ceiling",
			factory(api) {
				api.on("tool_call", (event) =>
					allowed(event.toolName)
						? undefined
						: {
								block: true,
								reason: `Tool '${event.toolName}' is outside the child allowlist.`,
							},
				);
				api.on("before_agent_start", () => {
					api.setActiveTools(api.getActiveTools().filter(allowed));
				});
			},
		});
	if (launch.runtime.capabilityCeiling?.denyExtensions) return ceiling;
	// Test doubles predating native MCP do not supply these exports. Real hosts
	// must satisfy the package's Pi >=0.99 peer requirement.
	if (!pi.createMcpExtension) return ceiling;
	factories.push({
		name: "mcp",
		builtin: true,
		factory(api) {
			const nativeApi: ExtensionAPI = {
				...api,
				registerTool(definition) {
					const selectedBySelector = launch.mcpSelections?.some(
						(grant) =>
							childToolNameMatches(grant.name, definition.name) &&
							(grant.selector.includes("/")
								? grant.selector === definition.label
								: definition.label.startsWith(`${grant.selector}/`)),
					);
					const mapped = launch.mcpSelections?.some((grant) =>
						childToolNameMatches(grant.name, definition.name),
					);
					const selected =
						selectedBySelector ||
						(!mapped && launch.tools?.includes(definition.name));
					// A namespace prefix alone is ambiguous when server names contain "__".
					// Preserve raw selectors to avoid granting another server or a sanitized collision.
					const patterned = launch.tools?.some(
						(grant) =>
							grant.endsWith("__*") &&
							childToolNameMatches(grant, definition.name),
					);
					const permitted =
						allowed(definition.name) &&
						(!patterned || selectedBySelector === true) &&
						(!launch.mcpSelections?.some(
							(grant) => grant.name === definition.name,
						) ||
							selectedBySelector === true);
					api.registerTool({
						...definition,
						exposure: !permitted
							? "hidden"
							: selected && definition.exposure !== "hidden"
								? "direct"
								: definition.exposure,
					});
				},
			};
			return pi.createMcpExtension()(nativeApi);
		},
	});
	factories.push({
		name: "codemode",
		builtin: true,
		factory: pi.createCodemodeExtension({ mode: "on" }),
	});
	factories.push({
		name: "tool_search",
		builtin: true,
		factory: pi.createToolSearchExtension(),
	});
	return [...factories, ...ceiling];
}
