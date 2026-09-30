import { expect, test } from "bun:test";
import { summarizePortableHistory } from "./portable-summary";
import { DEFAULT_EXTENSION_CONFIG } from "./types";

const mkModel = (provider: string, id: string, contextWindow = 100_000) => ({
	provider, id, api: "openai-responses", name: id, baseUrl: "https://example.invalid/v1",
	input: ["text"], reasoning: false, contextWindow, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const current = mkModel("openai", "gpt-native");
const kimi = mkModel("codex-local", "kimi-k3");
const backup = mkModel("codex-local", "gpt-backup");
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

function context() {
	return {
		model: current,
		thinkingLevel: "off",
		modelRegistry: {
			find: (provider: string, id: string) => [kimi, backup, current].find((model) => model.provider === provider && model.id === id),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-local-only" }),
		},
	};
}

test("lazy portable summary tries Kimi then configured backup, without leaking a partial summary", async () => {
	const calls: string[] = [];
	const result = await summarizePortableHistory({
		messages: [user("first fact"), user("second fact")] as never,
		ctx: context() as never,
		config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3", additionalCompactionModels: ["codex-local/gpt-backup"] },
		generate: async ({ model }) => {
			calls.push(`${model.provider}/${model.id}`);
			if (model.id === "kimi-k3") throw new Error("Kimi unavailable");
			return { text: "## Goal\nPortable backup", usage: undefined };
		},
	});
	expect(result).toMatchObject({ ok: true, summary: "## Goal\nPortable backup", model: { provider: "codex-local", id: "gpt-backup" } });
	expect(calls).toEqual(["codex-local/kimi-k3", "codex-local/gpt-backup"]);
});

test("local model IDs are tried in priority order with individual thinking levels and no extra probe", async () => {
	const sol = mkModel("codex-local-8319", "gpt-6-sol");
	const astra = mkModel("codex-local", "gpt-6-astra");
	const calls: Array<{ spec: string; level: string }> = [];
	const ctx = {
		model: current,
		thinkingLevel: "off",
		modelRegistry: {
			getAll: () => [sol, kimi, astra, mkModel("qoder-cli", "kimi-k3")],
			find: (provider: string, id: string) => [sol, kimi, astra, current].find((model) => model.provider === provider && model.id === id),
			getApiKeyAndHeaders: async (model: { id: string }) => ({ ok: model.id !== "gpt-6-sol", apiKey: "synthetic-only" }),
		},
	};
	const result = await summarizePortableHistory({
		messages: [user("history")] as never,
		ctx: ctx as never,
		config: {
			...DEFAULT_EXTENSION_CONFIG,
			compactionModel: "codex-local/legacy-ignored",
			localCompactionModels: [
				{ modelId: "gpt-6-sol", thinkingLevel: "max" },
				{ modelId: "kimi-k3", thinkingLevel: "max" },
				{ modelId: "gpt-6-astra", thinkingLevel: "high" },
			],
		},
		generate: async ({ model, thinkingLevel }) => {
			calls.push({ spec: `${model.provider}/${model.id}`, level: thinkingLevel });
			if (model.id === "kimi-k3") throw new Error("synthetic failure");
			return { text: "Portable history", usage: undefined };
		},
	});
	expect(result).toMatchObject({ ok: true, model: { id: "gpt-6-astra" } });
	expect(calls).toEqual([
		{ spec: "codex-local/kimi-k3", level: "max" },
		{ spec: "codex-local/gpt-6-astra", level: "high" },
	]);
});

test("model registry lookup failure skips to the next configured candidate", async () => {
	const ctx = context();
	const originalFind = ctx.modelRegistry.find;
	ctx.modelRegistry.find = (provider: string, id: string) => {
		if (id === "kimi-k3") throw new Error("synthetic registry failure");
		return originalFind(provider, id);
	};
	const result = await summarizePortableHistory({
		messages: [user("portable fact")] as never,
		ctx: ctx as never,
		config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3", additionalCompactionModels: ["codex-local/gpt-backup"] },
		generate: async () => ({ text: "## Goal\nBackup", usage: undefined }),
	});
	expect(result).toMatchObject({ ok: true, model: { id: "gpt-backup" } });
});

test("manual compaction guidance reaches the portable summarizer", async () => {
	let received: string | undefined;
	const result = await summarizePortableHistory({
		messages: [user("an exact decision")] as never,
		ctx: context() as never,
		config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" },
		customInstructions: "Keep the exact decision.",
		generate: async ({ customInstructions }) => {
			received = customInstructions;
			return { text: "## Goal\nKeep the exact decision.", usage: undefined };
		},
	});
	expect(result.ok).toBe(true);
	expect(received).toBe("Keep the exact decision.");
});

test("long source is summarized in ordered chunks with the preceding summary, not silently truncated", async () => {
	const seen: Array<{ text: string; prior?: string }> = [];
	const progress: string[] = [];
	const source = [user("fact-A-aaaaaaaaaa"), user("fact-B-bbbbbbbbbb"), user("fact-C-cccccccccc")];
	const result = await summarizePortableHistory({
		messages: source as never,
		ctx: context() as never,
		config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" },
		maxChunkBytes: 40,
		onProgress: ({ chunkIndex, chunkCount, phase }) => progress.push(`${chunkIndex}/${chunkCount}:${phase}`),
		generate: async ({ messages, previousSummary }) => {
			seen.push({ text: JSON.stringify(messages), prior: previousSummary });
			return { text: `summary-${seen.length}`, usage: undefined };
		},
	});
	expect(result).toMatchObject({ ok: true, summary: "summary-3" });
	expect(seen.map((call) => call.prior)).toEqual([undefined, "summary-1", "summary-2"]);
	expect(progress).toEqual([
		"1/3:start", "1/3:complete",
		"2/3:start", "2/3:complete",
		"3/3:start", "3/3:complete",
	]);
	for (const fact of ["fact-A", "fact-B", "fact-C"]) {
		expect(seen.some((call) => call.text.includes(fact))).toBe(true);
	}
});

test("all candidates failing returns an explicit failure without a placeholder or partial success", async () => {
	const calls: string[] = [];
	const result = await summarizePortableHistory({
		messages: [user("a fact")] as never,
		ctx: context() as never,
		config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3", additionalCompactionModels: ["codex-local/gpt-backup"] },
		generate: async ({ model }) => { calls.push(model.id); throw new Error("synthetic failure"); },
	});
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe("all-models-failed");
	expect(calls).toEqual(["kimi-k3", "gpt-backup", "gpt-native"]);
});
