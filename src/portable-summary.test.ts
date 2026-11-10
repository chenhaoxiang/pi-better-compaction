import { expect, test } from "bun:test";
import { isPortableSummaryCheckpoint, portableProgressOptions, PORTABLE_PROGRESS_ENTRY_TYPE, summarizePortableHistory } from "./portable-summary";
import { DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";

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

test("reports a failed progress event when a chunk returns empty text", async () => {
	const progress: string[] = [];
	const result = await summarizePortableHistory({
		messages: [user("fact-A-aaaaaaaaaa"), user("fact-B-bbbbbbbbbb")] as never,
		ctx: { ...context(), model: undefined } as never,
		config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" },
		maxChunkBytes: 40,
		onProgress: ({ chunkIndex, chunkCount, phase }) => progress.push(`${chunkIndex}/${chunkCount}:${phase}`),
		generate: async ({ previousSummary }) => ({ text: previousSummary ? "" : "summary-1", usage: undefined }),
	});
	expect(result).toMatchObject({ ok: false, reason: "all-models-failed" });
	expect(progress).toEqual([
		"1/2:start", "1/2:complete",
		"2/2:start", "2/2:failed",
	]);
});

test("reports a failed progress event when the accumulated summary exceeds the safe input budget", async () => {
	const progress: string[] = [];
	const result = await summarizePortableHistory({
		messages: [user("a".repeat(600)), user("b".repeat(600))] as never,
		ctx: {
			...context(),
			model: undefined,
			modelRegistry: {
				...context().modelRegistry,
				find: (provider: string, id: string) => mkModel(provider, id, 8192),
			},
		} as never,
		config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" },
		maxChunkBytes: 1024,
		onProgress: ({ chunkIndex, chunkCount, phase }) => progress.push(`${chunkIndex}/${chunkCount}:${phase}`),
		generate: async () => ({ text: "s".repeat(1800), usage: undefined }),
	});
	expect(result).toMatchObject({ ok: false, reason: "all-models-failed" });
	expect(progress).toEqual([
		"1/2:start", "1/2:complete",
		"2/2:failed",
	]);
});

test("cancelled portable work resumes only its verified completed prefix without repeating model calls", async () => {
	const checkpoints: unknown[] = []; const controller = new AbortController(); let firstCalls = 0;
	const source = [user("fact-A-aaaaaaaaaa"), user("fact-B-bbbbbbbbbb"), user("fact-C-cccccccccc")];
	const base = { messages: source as never, ctx: context() as never, config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" }, maxChunkBytes: 40, checkpointId: "native-1" };
	const cancelled = await summarizePortableHistory({ ...base, signal: controller.signal,
		onCheckpoint: value => { checkpoints.push(value); controller.abort(); },
		generate: async () => ({ text: `prefix-${++firstCalls}` }),
	});
	expect(cancelled).toMatchObject({ ok: false, reason: "aborted" }); expect(firstCalls).toBe(1); expect(checkpoints).toHaveLength(1);
	const seen: Array<{ text: string; prior?: string }> = [];
	const resumed = await summarizePortableHistory({ ...base, checkpoints: checkpoints as never,
		generate: async ({ messages, previousSummary }) => { seen.push({ text: JSON.stringify(messages), prior: previousSummary }); return { text: `resumed-${seen.length}` }; },
	});
	expect(resumed.ok).toBe(true); expect(seen).toHaveLength(2); expect(seen[0].prior).toBe("prefix-1");
	expect(seen[0].text).toContain("fact-B"); expect(seen.some(call => call.text.includes("fact-A"))).toBe(false);
});

test("large-model default planning uses its existing safe half-window bound instead of an arbitrary250k cap", async () => {
	const big = mkModel("codex-local", "large", 872000); let calls = 0; const seen: string[] = [];
	const source = Array.from({ length: 12 }, (_, i) => user(`fact-${i}:` + "a".repeat(69000)));
	const result = await summarizePortableHistory({ messages: source as never,
		ctx: { ...context(), model: undefined, modelRegistry: { find: () => big, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic" }) } } as never,
		config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/large" },
		generate: async ({ messages }) => { calls++; seen.push(JSON.stringify(messages)); return { text: "complete accumulated summary" }; },
	});
	expect(result.ok).toBe(true); expect(calls).toBe(2); for (let i = 0; i < 12; i++) expect(seen.some(s => s.includes(`fact-${i}:`))).toBe(true);
});

test("planning yields to native cancellation before generating on a long history", async () => {
	const controller = new AbortController(); let calls = 0;
	const cancel = setImmediate(() => controller.abort());
	try {
		const result = await summarizePortableHistory({ messages: Array.from({ length: 1024 }, () => user("small fact")) as never,
			ctx: context() as never, config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" }, signal: controller.signal,
			generate: async () => { calls++; return { text: "history" }; },
		});
		expect(result).toMatchObject({ ok: false, reason: "aborted" }); expect(calls).toBe(0);
	} finally { clearImmediate(cancel); }
});

test("prefix reuse rejects changed history, endpoint, instructions, thinking, checkpoint or corrupted output", async () => {
	const source = [user("fact-A-aaaaaaaaaa"), user("fact-B-bbbbbbbbbb"), user("fact-C-cccccccccc")];
	const saved: any[] = []; const controller = new AbortController();
	const base = { messages: source as never, ctx: context() as never, config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" }, checkpointId: "native-1", maxChunkBytes: 40 };
	await summarizePortableHistory({ ...base, signal: controller.signal, onCheckpoint: value => { saved.push(value); controller.abort(); }, generate: async () => ({ text: "saved-prefix" }) });
	expect(isPortableSummaryCheckpoint(saved[0])).toBe(true);
	const changes: any[] = [
		{ messages: [user("edited-fact-A"), ...source.slice(1)] }, { checkpointId: "native-2" },
		{ customInstructions: "new guidance" }, { config: { ...base.config, compactionThinkingLevel: "high" } },
		{ ctx: { ...context(), modelRegistry: { ...context().modelRegistry, find: () => ({ ...kimi, baseUrl: "https://other.invalid/v1" }) } } },
		{ checkpoints: [{ ...saved[0], summary: "corrupted" }] }, { checkpoints: [{ ...saved[0], version: 2 }] },
		{ checkpoints: [{ ...saved[0], completedChunks: 9999 }] }, { checkpoints: [{ ...saved[0], prefixDigest: "bad" }] },
	];
	for (const change of changes) {
		const seen: Array<string | undefined> = [];
		const result = await summarizePortableHistory({ ...base, checkpoints: saved, ...change, generate: async ({ previousSummary }) => { seen.push(previousSummary); return { text: "fresh" }; } });
		expect(result.ok).toBe(true); expect(seen[0]).toBeUndefined(); expect(seen.length).toBeGreaterThan(1);
	}
});

test("append-only tail keeps a matching completed prefix, and cache write failures do not replay requests", async () => {
	const saved: any[] = []; const controller = new AbortController();
	const base = { messages: [user("fact-A-aaaaaaaaaa"), user("fact-B-bbbbbbbbbb")] as never, ctx: context() as never, config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" }, checkpointId: "native-1", maxChunkBytes: 40 };
	await summarizePortableHistory({ ...base, signal: controller.signal, onCheckpoint: value => { saved.push(value); controller.abort(); }, generate: async () => ({ text: "A" }) });
	const seen: string[] = [];
	const result = await summarizePortableHistory({ ...base, messages: [...base.messages, user("fact-C-cccccccccc")] as never, checkpoints: saved,
		onCheckpoint: () => { throw new Error("synthetic optional persistence failure"); },
		generate: async ({ messages }) => { seen.push(JSON.stringify(messages)); return { text: "all facts" }; },
	});
	expect(result.ok).toBe(true); expect(seen).toHaveLength(2); expect(seen.join(" ")).not.toContain("fact-A");
	const branch = saved.map(data => ({ type: "custom", customType: PORTABLE_PROGRESS_ENTRY_TYPE, data }));
	const options = portableProgressOptions(branch as never, "native-1"); expect(options.checkpoints).toHaveLength(1);
	expect(portableProgressOptions(branch as never, "other").checkpoints).toHaveLength(0);
	expect(portableProgressOptions([...branch, { type: "custom", customType: PORTABLE_PROGRESS_ENTRY_TYPE, data: null }] as never, "native-1").checkpoints).toHaveLength(1);
});

test("a complete cached prefix cannot turn an explicit cancellation or a placeholder into success", async () => {
	const saved: any[] = []; const base = { messages: [user("fact-A")] as never, ctx: context() as never, config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3" }, checkpointId: "native-1" };
	await summarizePortableHistory({ ...base, onCheckpoint: value => saved.push(value), generate: async () => ({ text: "complete fact-A" }) });
	const controller = new AbortController(); let calls = 0;
	const result = await summarizePortableHistory({ ...base, checkpoints: saved, signal: controller.signal, onCandidate: () => controller.abort(), generate: async () => { calls++; return { text: "must not run" }; } });
	expect(result).toMatchObject({ ok: false, reason: "aborted" }); expect(calls).toBe(0);
	const invalid = await summarizePortableHistory({ ...base, generate: async () => ({ text: NATIVE_COMPACTION_FALLBACK_SUMMARY }) });
	expect(invalid.ok).toBe(false);
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
