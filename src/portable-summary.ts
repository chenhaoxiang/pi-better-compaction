import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, generateSummaryWithUsage, serializeConversation, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { getTextCompactionCandidates, type TextCompactionCandidate } from "./model-candidates";
import { NATIVE_COMPACTION_FALLBACK_SUMMARY, type ExtensionConfig } from "./types";

type Auth = { apiKey?: string; headers?: Record<string, string | null>; env?: Record<string, string>; baseUrl?: string };
type GenerateInput = {
	messages: AgentMessage[];
	model: Model<Api>;
	auth: Auth;
	previousSummary?: string;
	customInstructions?: string;
	thinkingLevel: ThinkingLevel;
	signal?: AbortSignal;
	sessionId?: string;
	reserveTokens: number;
};
export type PortableSummaryGenerator = (input: GenerateInput) => Promise<{ text: string; usage?: Usage }>;
export type PortableUsageRecord = { provider: string; model: string; usage: Usage };
export type PortableSummaryProgress = {
	candidate: TextCompactionCandidate;
	chunkIndex: number;
	chunkCount: number;
	phase: "start" | "complete" | "failed";
};
export const PORTABLE_PROGRESS_ENTRY_TYPE = "pi-better-compaction-portable-progress";
/** Never a complete-history summary. It is usable only after exact prefix/identity validation. */
export type PortableSummaryCheckpoint = {
	version: 1;
	checkpointId: string;
	candidateDigest: string;
	prefixDigest: string;
	completedChunks: number;
	summaryDigest: string;
	summary: string;
};
const MAX_CHECKPOINT_BYTES = 1_048_576;
const MAX_CHECKPOINT_CHUNKS = 4096;
export function isPortableSummaryCheckpoint(value: unknown): value is PortableSummaryCheckpoint {
	if (!value || typeof value !== "object") return false;
	const v = value as PortableSummaryCheckpoint;
	return v.version === 1 && typeof v.checkpointId === "string" && v.checkpointId.length > 0 && v.checkpointId.length <= 512 &&
		typeof v.candidateDigest === "string" && /^[a-f0-9]{64}$/.test(v.candidateDigest) &&
		typeof v.prefixDigest === "string" && /^[a-f0-9]{64}$/.test(v.prefixDigest) &&
		Number.isSafeInteger(v.completedChunks) && v.completedChunks > 0 && v.completedChunks <= MAX_CHECKPOINT_CHUNKS &&
		typeof v.summary === "string" && v.summary.trim().length > 0 && v.summary.trim() !== NATIVE_COMPACTION_FALLBACK_SUMMARY && Buffer.byteLength(v.summary, "utf8") <= MAX_CHECKPOINT_BYTES &&
		typeof v.summaryDigest === "string" && /^[a-f0-9]{64}$/.test(v.summaryDigest) && createHash("sha256").update(v.summary).digest("hex") === v.summaryDigest;
}
/** Progress is an optional bounded cache, never a second history or authority source. */
export function portableProgressOptions(branch: readonly SessionEntry[], checkpointId: string, appendEntry?: (type: string, data: unknown) => void) {
	const checkpoints: PortableSummaryCheckpoint[] = [], seen = new Set<string>();
	for (let i = branch.length - 1, inspected = 0; i >= 0 && inspected < 4096 && checkpoints.length < 8; i--, inspected++) {
		const entry = branch[i];
		if (entry?.type !== "custom" || entry.customType !== PORTABLE_PROGRESS_ENTRY_TYPE) continue;
		const data = entry.data as Partial<PortableSummaryCheckpoint> | undefined;
		if (data?.checkpointId !== checkpointId || typeof data.candidateDigest !== "string" || seen.has(data.candidateDigest)) continue;
		if (isPortableSummaryCheckpoint(data)) { checkpoints.push(data); seen.add(data.candidateDigest); }
	}
	return { checkpointId, checkpoints, onCheckpoint: appendEntry ? (value: PortableSummaryCheckpoint) => appendEntry(PORTABLE_PROGRESS_ENTRY_TYPE, value) : undefined };
}

export type PortableSummaryResult =
	| { ok: true; summary: string; model: { provider: string; id: string }; usageRecords: PortableUsageRecord[] }
	| { ok: false; reason: "aborted" | "all-models-failed"; usageRecords: PortableUsageRecord[] };

function serializedBytes(messages: AgentMessage[]): number {
	return Buffer.byteLength(serializeConversation(convertToLlm(messages)), "utf8");
}

/** Linear sizing, exact chunk recheck, and cooperative native-input cancellation. */
async function chunkByUserTurn(messages: AgentMessage[], budget: number, signal?: AbortSignal): Promise<AgentMessage[][] | undefined> {
	type Unit = { messages: AgentMessage[]; bytes: number; nonempty: boolean };
	const units: Unit[] = [];
	let turn: Unit[] = [];
	let turnBytes = 0, turnNonempty = false;
	const flushTurn = () => {
		if (!turn.length) return;
		if (turnBytes > budget) { for (const unit of turn) units.push(unit); }
		else units.push({ messages: turn.flatMap(u => u.messages), bytes: turnBytes, nonempty: turnNonempty });
		turn = []; turnBytes = 0; turnNonempty = false;
	};
	for (let i = 0; i < messages.length; i++) {
		if (i > 0 && i % 64 === 0) await yieldToEventLoop();
		if (signal?.aborted) return;
		const message = messages[i];
		if (message.role === "user") flushTurn();
		const bytes = serializedBytes([message]);
		turnBytes += bytes + (turnNonempty && bytes > 0 ? 2 : 0);
		turnNonempty ||= bytes > 0;
		turn.push({ messages: [message], bytes, nonempty: bytes > 0 });
	}
	flushTurn();
	const chunks: AgentMessage[][] = [];
	let chunk: AgentMessage[] = [], bytes = 0, nonempty = false;
	for (let i = 0; i < units.length; i++) {
		if (i > 0 && i % 64 === 0) await yieldToEventLoop();
		if (signal?.aborted) return;
		const unit = units[i];
		if (unit.bytes > budget) return;
		const combined = bytes + unit.bytes + (nonempty && unit.nonempty ? 2 : 0);
		if (chunk.length && combined > budget) {
			chunks.push(chunk); chunk = []; bytes = 0; nonempty = false;
		}
		bytes += unit.bytes + (nonempty && unit.nonempty ? 2 : 0);
		nonempty ||= unit.nonempty;
		for (const message of unit.messages) chunk.push(message);
	}
	if (chunk.length) chunks.push(chunk);
	// SDK serializers may evolve: estimates can never authorize an oversized request.
	for (let i = 0; i < chunks.length; i++) {
		if (i > 0 && i % 64 === 0) await yieldToEventLoop();
		if (signal?.aborted || serializedBytes(chunks[i]) > budget) return;
	}
	return chunks;
}

function cleanHeaders(headers: Auth["headers"]): Record<string, string> | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const defaultGenerate: PortableSummaryGenerator = async (input) => generateSummaryWithUsage(
	input.messages, input.model, input.reserveTokens, input.auth.apiKey,
	cleanHeaders(input.auth.headers), input.signal, input.customInstructions, input.previousSummary,
	input.thinkingLevel, undefined, input.auth.env, undefined, undefined, input.sessionId,
);

/** Complete coverage only. Reported usage contains calls made by this invocation, never reused-prefix calls. */
export async function summarizePortableHistory(args: {
	messages: AgentMessage[];
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">;
	config: ExtensionConfig;
	signal?: AbortSignal;
	sessionId?: string;
	maxChunkBytes?: number;
	customInstructions?: string;
	generate?: PortableSummaryGenerator;
	checkpointId?: string;
	checkpoints?: readonly PortableSummaryCheckpoint[];
	onCheckpoint?: (checkpoint: PortableSummaryCheckpoint) => void;
	onCandidate?: (candidate: TextCompactionCandidate) => void;
	onProgress?: (progress: PortableSummaryProgress) => void;
}): Promise<PortableSummaryResult> {
	const { messages, ctx, config, signal } = args;
	const usageRecords: PortableUsageRecord[] = [];
	if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
	if (messages.length === 0) return { ok: true, summary: "No earlier conversation was omitted by compaction.", model: { provider: ctx.model?.provider ?? "none", id: ctx.model?.id ?? "none" }, usageRecords };
	const { candidates } = getTextCompactionCandidates(config, ctx.modelRegistry);
	const activeSpec = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	if (activeSpec && !candidates.some(candidate => candidate.spec === activeSpec)) candidates.push({ spec: activeSpec, thinkingLevel: ctx.thinkingLevel ?? config.compactionThinkingLevel });
	const generate = args.generate ?? defaultGenerate;
	for (const candidate of candidates) {
		if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
		const { spec } = candidate, slash = spec.indexOf("/");
		if (slash <= 0 || slash === spec.length - 1) continue;
		let model: Model<Api> | undefined;
		try { model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)); } catch { continue; }
		if (!model) continue;
		const reserveTokens = Math.min(16_384, Math.max(1024, Math.floor(model.contextWindow / 4)));
		const safeInputBytes = model.contextWindow - reserveTokens - 4096;
		// Keep the existing conservative half-window safety, without a250k cap on large models.
		const maxChunkBytes = Math.min(args.maxChunkBytes ?? MAX_CHECKPOINT_BYTES, Math.floor(safeInputBytes / 2));
		if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) continue;
		const chunks = await chunkByUserTurn(messages, maxChunkBytes, signal);
		if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
		if (!chunks) continue;
		let auth: Auth;
		try { const result = await ctx.modelRegistry.getApiKeyAndHeaders(model); if (!result.ok) continue; auth = result; } catch { continue; }
		const thinkingLevel = spec === activeSpec && config.localCompactionModels.length === 0 ? (ctx.thinkingLevel ?? candidate.thinkingLevel) : candidate.thinkingLevel;
		const candidateDigest = createHash("sha256").update(JSON.stringify({ version: 1, checkpointId: args.checkpointId, provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, authBaseUrl: auth.baseUrl, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reserveTokens, maxChunkBytes, thinkingLevel, customInstructions: args.customInstructions })).digest("hex");
		const prefixes: string[] = [];
		let digest = candidateDigest;
		for (let i = 0; i < chunks.length; i++) {
			if (i > 0 && i % 64 === 0) await yieldToEventLoop();
			if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
			digest = createHash("sha256").update(digest).update(JSON.stringify(chunks[i])).update(serializeConversation(convertToLlm(chunks[i]))).digest("hex"); prefixes.push(digest);
		}
		let summary: string | undefined, start = 0;
		if (args.checkpointId) {
			for (const saved of args.checkpoints ?? []) {
				if (isPortableSummaryCheckpoint(saved) && saved.checkpointId === args.checkpointId && saved.candidateDigest === candidateDigest && saved.completedChunks <= chunks.length && saved.completedChunks > start && saved.prefixDigest === prefixes[saved.completedChunks - 1]) {
					start = saved.completedChunks; summary = saved.summary;
				}
			}
		}
		try { args.onCandidate?.(candidate); } catch { /* Feedback cannot decide summarization. */ }
		if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
		let failed = false;
		for (let chunkIndex = start; chunkIndex < chunks.length; chunkIndex++) {
			const chunk = chunks[chunkIndex];
			const progress = (phase: PortableSummaryProgress["phase"]) => { try { args.onProgress?.({ candidate, chunkIndex: chunkIndex + 1, chunkCount: chunks.length, phase }); } catch { /* UI only. */ } };
			if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
			if (Buffer.byteLength(summary ?? "", "utf8") + serializedBytes(chunk) > safeInputBytes) { progress("failed"); failed = true; break; }
			progress("start");
			try {
				const response = await generate({ messages: chunk, model, auth, previousSummary: summary, customInstructions: args.customInstructions, thinkingLevel, signal, sessionId: args.sessionId, reserveTokens });
				if (response.usage) usageRecords.push({ provider: model.provider, model: model.id, usage: response.usage });
				if (!response.text.trim() || response.text.trim() === NATIVE_COMPACTION_FALLBACK_SUMMARY) { progress("failed"); failed = true; break; }
				summary = response.text.trim();
				if (args.checkpointId && chunkIndex < MAX_CHECKPOINT_CHUNKS && Buffer.byteLength(summary, "utf8") <= MAX_CHECKPOINT_BYTES) {
					try { args.onCheckpoint?.({ version: 1, checkpointId: args.checkpointId, candidateDigest, prefixDigest: prefixes[chunkIndex], completedChunks: chunkIndex + 1, summaryDigest: createHash("sha256").update(summary).digest("hex"), summary }); } catch { /* Optional progress persistence cannot authorize incomplete history. */ }
				}
				progress("complete");
				if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
			} catch {
				if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
				progress("failed"); failed = true; break;
			}
		}
		if (!failed && summary) return { ok: true, summary, model: { provider: model.provider, id: model.id }, usageRecords };
	}
	return { ok: false, reason: signal?.aborted ? "aborted" : "all-models-failed", usageRecords };
}
