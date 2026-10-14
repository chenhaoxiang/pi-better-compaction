import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { findLatestCompactionEntry } from "./details-store";
import { isNativeCompactionEntry, NATIVE_COMPACTION_FALLBACK_SUMMARY, ANTHROPIC_COMPACTION_STRATEGY } from "./types";

export type Attempt = { method: string; outcome: "response-ok" | "failed"; reason?: string };
const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
type Counts = { [K in typeof fields[number]]: number | null };
function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function counts(): Counts { return { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null }; }
function add(total: Counts, usage: unknown): boolean {
	if (!record(usage)) return false;
	let found = false;
	for (const key of fields) {
		const n = usage[key];
		if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) continue;
		const next = (total[key] ?? 0) + n;
		if (!Number.isSafeInteger(next)) continue;
		total[key] = next;
		found = true;
	}
	return found;
}

/** Counts observations once per persisted entry, not token estimates or billing. */
export function usageSnapshot(branch: readonly SessionEntry[]) {
	const compaction = counts(), portable = counts();
	let compactionRecords = 0, portableRecords = 0, missing = 0;
	const seen = new Set<string>();
	for (const entry of branch) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		if (entry.type === "compaction") {
			if (add(compaction, entry.usage)) compactionRecords++; else missing++;
		} else if (entry.type === "custom" && ["pi-better-compaction-portable-summary", "pi-better-compaction-portable-usage"].includes(entry.customType)) {
			const data = record(entry.data) ? entry.data : undefined;
			if (!Array.isArray(data?.usageRecords) || data.usageRecords.length === 0) { missing++; continue; }
			for (const value of data.usageRecords) {
				if (record(value) && add(portable, value.usage)) portableRecords++; else missing++;
			}
		}
	}
	return { compaction, portable, compactionRecords, portableRecords, missing };
}

export function checkpointSnapshot(branch: readonly SessionEntry[]) {
	const latest = findLatestCompactionEntry(branch);
	if (!latest) return "none";
	if (!isNativeCompactionEntry(latest)) return latest.summary === NATIVE_COMPACTION_FALLBACK_SUMMARY ? "invalid-opaque-checkpoint" : "text-summary";
	if (latest.details.strategy === ANTHROPIC_COMPACTION_STRATEGY) return "anthropic-readable-summary-and-block";
	return latest.summary === NATIVE_COMPACTION_FALLBACK_SUMMARY ? "openai-opaque-checkpoint" : "native-readable-summary";
}

export function registerCompactionDiagnostics(pi: ExtensionAPI, options: {
	attempts: () => readonly Attempt[];
	portableState: (branch: readonly SessionEntry[]) => string;
}) {
	// Optional only for synthetic legacy hosts; current Pi always supports commands.
	pi.registerCommand?.("compaction-status", {
		description: "Read checkpoint safety, recent fallback reasons and recorded compaction/portable token usage",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args.trim() && args.trim() !== "usage") { ctx.ui.notify("Usage: /compaction-status [usage]", "warning"); return; }
			try {
				const branch = ctx.sessionManager.getBranch();
				const lines: string[] = [];
				if (!args.trim()) {
					lines.push(`Checkpoint: ${checkpointSnapshot(branch)}`, `Portable history: ${options.portableState(branch)}`);
					for (const attempt of options.attempts()) lines.push(`${attempt.method}: ${attempt.outcome}${attempt.reason ? ` (${attempt.reason})` : ""}`);
					if (!options.attempts().length) lines.push("No compaction attempts recorded in this runtime.");
					lines.push("Attempt outcomes describe returned responses, not checkpoint persistence. Switch safety/endpoint identity is revalidated on the actual request, not certified by this command.");
				}
				const usage = usageSnapshot(branch);
				const format = (n: number | null) => n === null ? "unknown" : String(n);
				for (const [label, totals] of [["Compaction entries (already counted by Pi)", usage.compaction], ["Lazy portable calls (separate; not added to /session)", usage.portable]] as const) {
					lines.push(`${label}: ${fields.map(key => `${key}=${format(totals[key])}`).join(", ")}`);
				}
				lines.push(`Missing/unusable usage observations: ${usage.missing}; partial observed totals, not a complete bill. Cost: unpriced/unknown (token counts are not billing).`);
				ctx.ui.notify(lines.join("\n"), "info");
			} catch { ctx.ui.notify("Compaction diagnostics unavailable; no request or session mutation performed.", "warning"); }
		},
	});
}
