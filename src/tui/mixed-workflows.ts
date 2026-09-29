// Optional process-local bridge to independently installed pi-dynamic-workflows.
// Never import another Pi package by name: the package loader does not make it
// a dependency of this package. Only the workflow owner may open its run.
const SLOT = Symbol.for("pi.mixed-work.fleet.v1");

export interface MixedWorkflowRow {
	id: string;
	name: string;
	status: "running" | "paused" | "pending";
	phase: string;
	done: number;
	total: number;
	startedAt: number;
}

interface MixedFleetEntry {
	version: number;
	sessionId: string;
	rows: MixedWorkflowRow[];
	accepted: boolean;
	open: (id: string) => Promise<void>;
}

function current(sessionId: string | null | undefined): MixedFleetEntry | undefined {
	const value = (globalThis as Record<symbol, unknown>)[SLOT];
	if (!sessionId || !value || typeof value !== "object") return undefined;
	const entry = value as MixedFleetEntry;
	return entry.version === 1 && entry.sessionId === sessionId && Array.isArray(entry.rows) && typeof entry.open === "function"
		? entry : undefined;
}

function safeText(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}

/** Return only safe bounded rows; acknowledge only after a FleetView is live. */
export function readMixedWorkflows(sessionId: string | null | undefined): MixedWorkflowRow[] {
	const entry = current(sessionId);
	if (!entry) return [];
	if (entry.rows.length > 20) {
		entry.accepted = false;
		return [];
	}
	const rows: MixedWorkflowRow[] = [];
	for (const row of entry.rows) {
		if (!row || !safeText(row.id, 160) || !safeText(row.name, 160)
			|| (row.phase !== "" && !safeText(row.phase, 160))
			|| !(["running", "paused", "pending"] as unknown[]).includes(row.status)
			|| !Number.isSafeInteger(row.done) || !Number.isSafeInteger(row.total)
			|| row.done < 0 || row.total < row.done || row.total > 1000
			|| !Number.isSafeInteger(row.startedAt) || row.startedAt < 0) {
			entry.accepted = false;
			return [];
		}
		rows.push(row);
	}
	entry.accepted = true;
	return rows;
}

export async function openMixedWorkflow(sessionId: string | null | undefined, id: string): Promise<boolean> {
	const entry = current(sessionId);
	if (!entry || !entry.accepted || !entry.rows.some((row) => row.id === id)) return false;
	await entry.open(id);
	return true;
}

export function releaseMixedWorkflows(sessionId: string | null | undefined): void {
	const entry = current(sessionId);
	if (entry) entry.accepted = false;
}
