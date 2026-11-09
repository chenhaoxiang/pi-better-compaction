import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { findLatestCompactionEntry } from "./details-store";
import { isNativeCompactionEntry, NATIVE_COMPACTION_FALLBACK_SUMMARY, ANTHROPIC_COMPACTION_STRATEGY } from "./types";
import { NATIVE_ATTEMPT_ENTRY, V2_EVENTS, V2_PHASES, type V2CompactionDiagnostics } from "./v2-transport";

export type Attempt = { method: string; outcome: "response-ok" | "failed"; reason?: string; trigger?: "manual" | "threshold" | "overflow"; diagnostics?: V2CompactionDiagnostics };
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

const nativeReasons = new Set(["aborted", "deadline-exceeded", "idle-timeout", "network-error", "non-2xx", "provider-failed", "incomplete-response", "no-compaction-output", "multiple-compaction-outputs", "stream-parse-error", "retries-exhausted"]);

/** Project only closed labels and nonnegative counts out of untrusted persisted metadata. */
export function nativeAttemptHistory(branch: readonly SessionEntry[]): Attempt[] {
	const attempts: Attempt[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== NATIVE_ATTEMPT_ENTRY || !record(entry.data)) continue;
		const data = entry.data, d = data.diagnostics;
		if (data.schemaVersion !== 1 || data.method !== "Responses v2" || (data.outcome !== "response-ok" && data.outcome !== "failed") || !record(d)) continue;
		if (!(V2_PHASES as readonly unknown[]).includes(d.phase) || typeof d.outputReceived !== "boolean") continue;
		if (!["attempt", "elapsedMs", "idleMs", "receivedBytes", "eventCount"].every(key => typeof d[key] === "number" && Number.isSafeInteger(d[key]) && (d[key] as number) >= 0)) continue;
		const diagnostics: V2CompactionDiagnostics = {
			phase: d.phase as V2CompactionDiagnostics["phase"], attempt: d.attempt as number,
			elapsedMs: d.elapsedMs as number, idleMs: d.idleMs as number,
			receivedBytes: d.receivedBytes as number, eventCount: d.eventCount as number, outputReceived: d.outputReceived,
		};
		if (typeof d.firstByteMs === "number" && Number.isSafeInteger(d.firstByteMs) && d.firstByteMs >= 0) diagnostics.firstByteMs = d.firstByteMs;
		if ((V2_EVENTS as readonly unknown[]).includes(d.lastEvent)) diagnostics.lastEvent = d.lastEvent as V2CompactionDiagnostics["lastEvent"];
		if (typeof d.interruption === "string" && ["aborted", "deadline-exceeded", "idle-timeout"].includes(d.interruption)) diagnostics.interruption = d.interruption as V2CompactionDiagnostics["interruption"];
		attempts.push({
			method: "Responses v2", outcome: data.outcome as Attempt["outcome"], diagnostics,
			...(typeof data.reason === "string" ? { reason: nativeReasons.has(data.reason) ? data.reason : "unclassified" } : {}),
			...(typeof data.trigger === "string" && ["manual", "threshold", "overflow"].includes(data.trigger) ? { trigger: data.trigger as Attempt["trigger"] } : {}),
		});
		if (attempts.length > 12) attempts.shift();
	}
	return attempts;
}

function nativeTiming(d: V2CompactionDiagnostics): string {
	return `${d.phase}, attempt=${d.attempt}, elapsed=${d.elapsedMs}ms, idle=${d.idleMs}ms, firstByte=${d.firstByteMs ?? "unknown"}ms, bytes=${d.receivedBytes}, events=${d.eventCount}, last=${d.lastEvent ?? "unknown"}, output=${d.outputReceived}${d.interruption ? `, interrupted=${d.interruption}` : ""}`;
}

export function registerCompactionDiagnostics(pi: ExtensionAPI, options: {
	attempts: () => readonly Attempt[];
	activeNative?: () => V2CompactionDiagnostics | undefined;
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
					const active = options.activeNative?.();
					if (active) lines.push(`Native transport in progress: ${nativeTiming(active)}`);
					const runtime = options.attempts();
					const saved = runtime.some(attempt => attempt.method === "Responses v2") ? [] : nativeAttemptHistory(branch);
					for (const attempt of [...runtime, ...saved]) {
						lines.push(`${attempt.method}: ${attempt.outcome}${attempt.reason ? ` (${attempt.reason})` : ""}${attempt.trigger ? ` [${attempt.trigger}]` : ""}${attempt.diagnostics ? ` — ${nativeTiming(attempt.diagnostics)}` : ""}`);
					}
					if (!runtime.length) lines.push("No compaction attempts recorded in this runtime.");
					if (saved.length) lines.push("Native transport observations above were restored from the active branch; they do not certify checkpoint persistence or billing.");
					lines.push("Response outcomes describe returned responses, not checkpoint persistence. Native replay guard failures are local pre-send rejections, not provider calls. Switch safety/endpoint identity is revalidated on the actual request, not certified by this command.");
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
