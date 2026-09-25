import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, generateSummaryWithUsage, serializeConversation, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "./types";

type Auth = { apiKey?: string; headers?: Record<string, string | null>; env?: Record<string, string> };
type GenerateInput = {
	messages: AgentMessage[];
	model: Model<Api>;
	auth: Auth;
	previousSummary?: string;
	thinkingLevel: ThinkingLevel;
	signal?: AbortSignal;
	sessionId?: string;
	reserveTokens: number;
};
export type PortableSummaryGenerator = (input: GenerateInput) => Promise<{ text: string; usage?: Usage }>;
export type PortableUsageRecord = { provider: string; model: string; usage: Usage };
export type PortableSummaryResult =
	| { ok: true; summary: string; model: { provider: string; id: string }; usageRecords: PortableUsageRecord[] }
	| { ok: false; reason: "aborted" | "all-models-failed"; usageRecords: PortableUsageRecord[] };

function serializedBytes(messages: AgentMessage[]): number {
	return Buffer.byteLength(serializeConversation(convertToLlm(messages)), "utf8");
}

function chunkByUserTurn(messages: AgentMessage[], budget: number): AgentMessage[][] | undefined {
	const turns: AgentMessage[][] = [];
	let turn: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "user" && turn.length > 0) {
			turns.push(turn);
			turn = [];
		}
		turn.push(message);
	}
	if (turn.length > 0) turns.push(turn);

	const units = turns.flatMap((group) => serializedBytes(group) > budget ? group.map((message) => [message]) : [group]);
	const chunks: AgentMessage[][] = [];
	let chunk: AgentMessage[] = [];
	for (const unit of units) {
		if (serializedBytes(unit) > budget) return undefined;
		const candidate = [...chunk, ...unit];
		if (chunk.length > 0 && serializedBytes(candidate) > budget) {
			chunks.push(chunk);
			chunk = [...unit];
		} else {
			chunk = candidate;
		}
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

function cleanHeaders(headers: Auth["headers"]): Record<string, string> | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const defaultGenerate: PortableSummaryGenerator = async (input) => generateSummaryWithUsage(
	input.messages, input.model, input.reserveTokens, input.auth.apiKey,
	cleanHeaders(input.auth.headers), input.signal, undefined, input.previousSummary,
	input.thinkingLevel, undefined, input.auth.env, undefined, undefined, input.sessionId,
);

/** Summarize every hidden message in bounded chunks; failure never returns partial text. */
export async function summarizePortableHistory(args: {
	messages: AgentMessage[];
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">;
	config: ExtensionConfig;
	signal?: AbortSignal;
	sessionId?: string;
	maxChunkBytes?: number;
	generate?: PortableSummaryGenerator;
}): Promise<PortableSummaryResult> {
	const { messages, ctx, config, signal } = args;
	const usageRecords: PortableUsageRecord[] = [];
	if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
	if (messages.length === 0) {
		return {
			ok: true,
			summary: "No earlier conversation was omitted by compaction.",
			model: { provider: ctx.model?.provider ?? "none", id: ctx.model?.id ?? "none" },
			usageRecords,
		};
	}

	const candidates = [config.compactionModel, ...config.additionalCompactionModels,
		...(ctx.model ? [`${ctx.model.provider}/${ctx.model.id}`] : [])];
	const seen = new Set<string>();
	const generate = args.generate ?? defaultGenerate;
	for (const spec of candidates) {
		if (!spec || seen.has(spec)) continue;
		seen.add(spec);
		const slash = spec.indexOf("/");
		if (slash <= 0 || slash === spec.length - 1) continue;
		let model: Model<Api> | undefined;
		try { model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)); }
		catch { continue; }
		if (!model) continue;
		const reserveTokens = Math.min(16_384, Math.max(1024, Math.floor(model.contextWindow / 4)));
		const safeInputBytes = model.contextWindow - reserveTokens - 4096;
		const maxChunkBytes = Math.min(args.maxChunkBytes ?? 250_000, Math.floor(safeInputBytes / 2));
		if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) continue;
		const chunks = chunkByUserTurn(messages, maxChunkBytes);
		if (!chunks) continue;

		let auth: Auth;
		try {
			const result = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!result.ok) continue;
			auth = result;
		} catch {
			continue;
		}

		let summary: string | undefined;
		let failed = false;
		for (const chunk of chunks) {
			if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
			if (Buffer.byteLength(summary ?? "", "utf8") + serializedBytes(chunk) > safeInputBytes) {
				failed = true;
				break;
			}
			try {
				const response = await generate({
					messages: chunk,
					model,
					auth,
					previousSummary: summary,
					thinkingLevel: spec === `${ctx.model?.provider}/${ctx.model?.id}`
						? (ctx.thinkingLevel ?? config.compactionThinkingLevel)
						: config.compactionThinkingLevel,
					signal,
					sessionId: args.sessionId,
					reserveTokens,
				});
				if (!response.text.trim()) { failed = true; break; }
				summary = response.text.trim();
				if (response.usage) usageRecords.push({ provider: model.provider, model: model.id, usage: response.usage });
			} catch {
				if (signal?.aborted) return { ok: false, reason: "aborted", usageRecords };
				failed = true;
				break;
			}
		}
		if (!failed && summary) {
			return { ok: true, summary, model: { provider: model.provider, id: model.id }, usageRecords };
		}
	}
	return { ok: false, reason: signal?.aborted ? "aborted" : "all-models-failed", usageRecords };
}
