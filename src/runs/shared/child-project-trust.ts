import type {
	LoadExtensionsResult,
	ProjectTrustEventResult,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	ChildSessionLaunch,
	PiCodingAgentModule,
} from "./child-session.ts";

/** SDK custom loaders own trust resolution. Match Pi's noninteractive policy:
 * user extension decision, saved decision, then global default (ask means no).
 * Never infer trust from an agent's request for tools or a project setting.
 */
export async function resolveChildProjectTrust(
	pi: PiCodingAgentModule,
	launch: Pick<ChildSessionLaunch, "cwd" | "onExtensionError">,
	settings: SettingsManager,
	agentDir: string,
	result: LoadExtensionsResult,
): Promise<boolean> {
	if (!pi.hasTrustRequiringProjectResources(launch.cwd)) return true;
	const store = new pi.ProjectTrustStore(agentDir);
	const ctx = {
		cwd: launch.cwd,
		mode: "print" as const,
		hasUI: false,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
		},
	};
	for (const extension of result.extensions) {
		for (const handler of extension.handlers.get("project_trust") ?? []) {
			try {
				// SAFETY: Only project_trust handlers are selected from Pi's loaded extension registry.
				const decision = (await handler(
					{ type: "project_trust", cwd: launch.cwd },
					ctx,
				)) as ProjectTrustEventResult | undefined;
				if (decision?.trusted !== "yes" && decision?.trusted !== "no") continue;
				const trusted = decision.trusted === "yes";
				if (decision.remember) store.set(launch.cwd, trusted);
				return trusted;
			} catch (error) {
				launch.onExtensionError?.({
					extensionPath: extension.path,
					event: "project_trust",
					error,
				});
			}
		}
	}
	return (
		store.get(launch.cwd) ?? settings.getDefaultProjectTrust() === "always"
	);
}
