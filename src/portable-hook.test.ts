import { expect, test } from "bun:test";
import { registerExtensionRuntime } from "./extension-runtime";
import { serializeMessagesToResponsesInput } from "./serializer";
import { createNativeCompactionDetails, DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";

const stamp = "2026-09-25T12:00:00.000Z";
const nativeModel = { provider: "openai", api: "openai-responses", id: "gpt-native", baseUrl: "https://example.invalid/v1", input: ["text"], reasoning: false };
const switchedModel = { ...nativeModel, provider: "anthropic", api: "anthropic-messages", id: "claude-test" };
const user = (id: string, parentId: string | null, text: string) => ({
	type: "message", id, parentId, timestamp: stamp,
	message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});
const old = user("old", null, "Hidden decision A");
const kept = user("kept", "old", "Kept fact");
const checkpoint = {
	type: "compaction", id: "native1", parentId: "kept", timestamp: stamp,
	firstKeptEntryId: "kept", summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 2500,
	details: createNativeCompactionDetails({
		provider: nativeModel.provider, api: nativeModel.api, model: nativeModel.id, baseUrl: nativeModel.baseUrl,
		compactedWindow: [{ type: "compaction", encrypted_content: "opaque-blob" }],
	}),
};
const tail = user("tail", "native1", "Actual first new-model message");
const originalMessages = [
	{ role: "compactionSummary", summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 2500, timestamp: 1 },
	tail.message,
];

function harness(opts: { fail?: boolean; failWithUsage?: boolean; initialEntries?: any[]; debugArtifactsFail?: boolean; configThrows?: boolean; disabled?: boolean } = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
	const entries: any[] = opts.initialEntries ? [...opts.initialEntries] : [old, kept, checkpoint, tail];
	const generated: string[][] = [];
	const notices: string[] = [];
	let aborted = 0;
	registerExtensionRuntime({
		on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler),
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data, id: `portable-${entries.length}`, parentId: entries.at(-1)?.id, timestamp: stamp });
		},
	} as never, {
		loadExtensionConfig: () => {
			if (opts.configThrows) throw new Error("synthetic config read failure");
			return { config: {
				...DEFAULT_EXTENSION_CONFIG, compactionModel: "codex-local/kimi-k3",
				...(opts.disabled ? { enabled: false } : {}),
				...(opts.debugArtifactsFail ? { debug: true, logProviderPayloads: true, artifactRoot: "/dev/null/pi-better-compaction" } : {}),
			}, warnings: [] };
		},
		executeNativeCompaction: async () => ({ ok: false, reason: "non-2xx" }) as never,
		executeV2Compaction: async () => ({ ok: false, reason: "non-2xx" }) as never,
		runNativeFallbackCompaction: async () => ({ ok: false, reason: "no-model-configured" }) as never,
		summarizePortableHistory: async ({ messages }: { messages: Array<{ content?: unknown }> }) => {
			generated.push(messages.map((message) => JSON.stringify(message)));
			return opts.fail || opts.failWithUsage
				? { ok: false, reason: "all-models-failed", usageRecords: opts.failWithUsage ? [{ provider: "codex-local", model: "kimi-k3", usage: { input: 10, output: 2, totalTokens: 12, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] : [] }
				: { ok: true, summary: "## Goal\nPortable decision A", model: { provider: "codex-local", id: "kimi-k3" }, usageRecords: [] };
		},
	} as never);
	const makeCtx = (model = switchedModel) => ({
		model,
		hasUI: true,
		ui: { notify: (text: string) => notices.push(text) },
		signal: new AbortController().signal,
		cwd: "/synthetic",
		getSystemPrompt: () => "Synthetic prompt",
		modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-local-only" }) },
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "synthetic-session",
			getSessionFile: () => undefined,
			getSessionDir: () => "/synthetic",
		},
		abort: () => { aborted++; },
	});
	return { handlers, entries, generated, notices, makeCtx, get aborted() { return aborted; } };
}

test("first incompatible request generates and caches portable text, but switching back never calls Kimi", async () => {
	const h = harness();
	const context = h.handlers.get("context");
	expect(context).toBeDefined();
	// Merely changing the selected model does not invoke a context/request hook.
	expect(h.generated).toHaveLength(0);
	const first = await context!({ messages: originalMessages }, h.makeCtx());
	expect(first.messages[0].summary).toBe("## Goal\nPortable decision A");
	expect(h.generated).toHaveLength(1);
	expect(h.generated[0].join(" ")).toContain("Hidden decision A");
	expect(h.generated[0].join(" ")).not.toContain("Kept fact");
	expect(h.entries.at(-1).type).toBe("custom");

	const resumed = harness({ initialEntries: h.entries });
	const resumedResult = await resumed.handlers.get("context")!({ messages: originalMessages }, resumed.makeCtx());
	expect(resumedResult.messages[0].summary).toBe("## Goal\nPortable decision A");
	expect(resumed.generated).toHaveLength(0);

	const second = await context!({ messages: originalMessages }, h.makeCtx());
	expect(second.messages[0].summary).toBe("## Goal\nPortable decision A");
	expect(h.generated).toHaveLength(1);
	const native = await context!({ messages: originalMessages }, h.makeCtx(nativeModel));
	expect(native).toBeUndefined();
	expect(h.generated).toHaveLength(1);
	expect(h.aborted).toBe(0);
});

test("an edit to hidden history invalidates a cached portable summary", async () => {
	const h = harness();
	await h.handlers.get("context")!({ messages: originalMessages }, h.makeCtx());
	expect(h.generated).toHaveLength(1);
	h.entries.push({
		type: "context_edit", id: "change-old", parentId: h.entries.at(-1)?.id, timestamp: stamp,
		targetId: "old", replacement: { content: [{ type: "text", text: "Updated decision A" }] },
	});
	await h.handlers.get("context")!({ messages: originalMessages }, h.makeCtx());
	expect(h.generated).toHaveLength(2);
	expect(h.generated[1].join(" ")).toContain("Updated decision A");
	expect(h.entries.filter((entry) => entry.type === "custom")).toHaveLength(2);
});

test("portable summarization failure aborts before a placeholder can be sent", async () => {
	const h = harness({ fail: true });
	const result = await h.handlers.get("context")!({ messages: originalMessages }, h.makeCtx());
	expect(result).toBeUndefined();
	expect(h.aborted).toBe(1);
	expect(h.entries.filter((entry) => entry.type === "custom")).toHaveLength(0);
	expect(h.notices.join(" ")).toContain("portable");
});

test("failed lazy summarization preserves paid usage as branch-local evidence before abort", async () => {
	const h = harness({ failWithUsage: true });
	await h.handlers.get("context")!({ messages: originalMessages }, h.makeCtx());
	expect(h.aborted).toBe(1);
	const usageEntries = h.entries.filter((entry) => entry.customType === "pi-better-compaction-portable-usage");
	expect(usageEntries).toHaveLength(1);
	expect(usageEntries[0].data.usageRecords[0]).toMatchObject({ provider: "codex-local", model: "kimi-k3" });
});

test("a failing notification cannot prevent the continuity abort", async () => {
	const h = harness({ fail: true });
	const ctx = h.makeCtx();
	ctx.ui.notify = () => { throw new Error("TUI unavailable"); };
	await h.handlers.get("context")!({ messages: originalMessages }, ctx);
	expect(h.aborted).toBe(1);
});

test("failed debug artifact writes cannot bypass an unsafe-provider abort", async () => {
	const h = harness({ debugArtifactsFail: true });
	const payload = { model: switchedModel.id, messages: [{ role: "user", content: NATIVE_COMPACTION_FALLBACK_SUMMARY }] };
	expect(await h.handlers.get("before_provider_request")!({ payload }, h.makeCtx())).toBeUndefined();
	expect(h.aborted).toBe(1);
});

test("failed debug writes cannot discard an otherwise valid native replay rewrite", async () => {
	const h = harness({ debugArtifactsFail: true });
	const payload = { model: nativeModel.id, instructions: "Synthetic prompt", input: [
		{ role: "system", content: "Synthetic prompt" },
		...serializeMessagesToResponsesInput(nativeModel as never, [originalMessages[0], kept.message, tail.message] as never),
	] };
	const rewritten = await h.handlers.get("before_provider_request")!({ payload }, h.makeCtx(nativeModel));
	expect(rewritten.input).toContainEqual({ type: "compaction", encrypted_content: "opaque-blob" });
	expect(h.aborted).toBe(0);
});

test("an incompatible provider request cannot send the opaque-only placeholder", async () => {
	const h = harness();
	const ctx = h.makeCtx();
	const before = h.handlers.get("before_provider_request")!;
	const placeholderPayload = { model: switchedModel.id, messages: [{ role: "user", content: NATIVE_COMPACTION_FALLBACK_SUMMARY }] };
	expect(await before({ payload: placeholderPayload }, ctx)).toBeUndefined();
	expect(h.aborted).toBe(1);
	await h.handlers.get("context")!({ messages: originalMessages }, h.makeCtx());
	expect(await before({ payload: { model: switchedModel.id, messages: [{ role: "user", content: "## Goal Portable decision A" }] } }, h.makeCtx())).toBeUndefined();
	expect(h.aborted).toBe(1);
});

test("disabling new compaction does not silently unlock an existing opaque checkpoint", async () => {
	const h = harness({ disabled: true });
	const payload = { model: nativeModel.id, input: [{ role: "user", content: NATIVE_COMPACTION_FALLBACK_SUMMARY }] };
	expect(await h.handlers.get("before_provider_request")!({ payload }, h.makeCtx(nativeModel))).toBeUndefined();
	expect(h.aborted).toBe(1);
});

test("corrupted native details with a persisted placeholder fail closed", async () => {
	const h = harness();
	h.entries[2] = { ...h.entries[2], details: { strategy: "unknown" } };
	await h.handlers.get("context")!({ messages: originalMessages }, h.makeCtx());
	expect(h.aborted).toBe(1);
	const payload = { model: nativeModel.id, input: [{ role: "user", content: NATIVE_COMPACTION_FALLBACK_SUMMARY }] };
	await h.handlers.get("before_provider_request")!({ payload }, h.makeCtx(nativeModel));
	expect(h.aborted).toBe(2);
	expect(await h.handlers.get("cache_warming_decision")!({ action: "warm" }, h.makeCtx())).toEqual({ action: "stop" });
});

test("unexpected config errors during context preparation abort the first switched request", async () => {
	const h = harness({ configThrows: true });
	expect(await h.handlers.get("context")!({ messages: originalMessages }, h.makeCtx())).toBeUndefined();
	expect(h.aborted).toBe(1);
});

test("unexpected config errors cannot leak an opaque-only placeholder through Pi's swallowed hook error", async () => {
	const h = harness({ configThrows: true });
	const payload = { model: nativeModel.id, input: [{ role: "user", content: NATIVE_COMPACTION_FALLBACK_SUMMARY }] };
	expect(await h.handlers.get("before_provider_request")!({ payload }, h.makeCtx(nativeModel))).toBeUndefined();
	expect(h.aborted).toBe(1);
});

test("auth resolution errors abort an opaque-only request instead of escaping into Pi's fail-open handler", async () => {
	const h = harness();
	const ctx = h.makeCtx(nativeModel);
	ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("synthetic auth lookup failure"); };
	const payload = { model: nativeModel.id, input: [{ role: "user", content: NATIVE_COMPACTION_FALLBACK_SUMMARY }] };
	expect(await h.handlers.get("before_provider_request")!({ payload }, ctx)).toBeUndefined();
	expect(h.aborted).toBe(1);
});

test("a native-model payload mismatch aborts rather than letting Pi send the placeholder", async () => {
	const h = harness();
	const payload = { model: nativeModel.id, instructions: "Synthetic prompt", input: [
		{ role: "system", content: "Synthetic prompt" },
		{ role: "user", content: [{ type: "input_text", text: NATIVE_COMPACTION_FALLBACK_SUMMARY }] },
	] };
	expect(await h.handlers.get("before_provider_request")!({ payload }, h.makeCtx(nativeModel))).toBeUndefined();
	expect(h.aborted).toBe(1);
});

test("cache warming stops for an incompatible model until portable text exists", async () => {
	const h = harness();
	const decision = h.handlers.get("cache_warming_decision");
	expect(decision).toBeDefined();
	expect(await decision!({ action: "warm" }, h.makeCtx())).toEqual({ action: "stop" });
	await h.handlers.get("context")!({ messages: originalMessages }, h.makeCtx());
	expect(await decision!({ action: "warm" }, h.makeCtx())).toBeUndefined();
});
