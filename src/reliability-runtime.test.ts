import { afterEach, expect, mock, test } from "bun:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { executeV2Compaction } from "./compact-client-v2";
import { registerExtensionRuntime } from "./extension-runtime";
import { nativeAttemptHistory } from "./diagnostics";
import { DEFAULT_EXTENSION_CONFIG, createNativeCompactionDetails, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";
import { NATIVE_ATTEMPT_ENTRY, V2Transport } from "./v2-transport";

const originalFetch = globalThis.fetch;
afterEach(() => { mock.restore(); globalThis.fetch = originalFetch; });
const stamp = "2026-11-09T00:00:00.000Z";
const model = { provider: "synthetic", api: "openai-responses", id: "synthetic-model", baseUrl: "https://example.invalid/v1", input: ["text"], reasoning: false };
const message = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
const old = message("old", null, "Important hidden decision");
const kept = message("kept", "old", "Previously retained decision");
const checkpoint = { type: "compaction", id: "native", parentId: "kept", timestamp: stamp, firstKeptEntryId: "kept", tokensBefore: 2000, summary: NATIVE_COMPACTION_FALLBACK_SUMMARY,
	details: createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, compactedWindow: [{ type: "compaction", encrypted_content: "old-private-blob" }] }) };
const tail = message("tail", "native", "Recent user goal");
function harness(opts: { opaque?: boolean; failPortable?: boolean; persistThrows?: boolean; uiThrows?: boolean; wire?: string; idleTimeoutMs?: number } = {}) {
	const entries: any[] = opts.opaque ? [old, kept, checkpoint, tail] : [old, kept];
	const hooks = new Map<string, any>(); const notices: string[] = [], statuses: Array<string | undefined> = [];
	let command: any, fallbacks = 0; const portable: any[] = [];
	const pi = {
		on: (name: string, handler: any) => hooks.set(name, handler),
		registerCommand: (_name: string, definition: any) => { command = definition; },
		appendEntry: (customType: string, data: unknown) => {
			if (opts.persistThrows) throw new Error("synthetic storage failure");
			entries.push({ type: "custom", customType, data, id: `observation-${entries.length}`, parentId: entries.at(-1)?.id, timestamp: stamp });
		},
	};
	registerExtensionRuntime(pi as never, {
		loadExtensionConfig: () => ({ config: { ...DEFAULT_EXTENSION_CONFIG, compactionModel: "local/synthetic", nativeV2IdleTimeoutMs: opts.idleTimeoutMs ?? 0 }, warnings: [] }),
		executeV2Compaction: (options: any) => executeV2Compaction({ ...options, timeoutMs: 60 }),
		runNativeFallbackCompaction: async () => { fallbacks++; return { ok: true, model: { provider: "local", id: "synthetic" }, result: { summary: "Safe text fallback", firstKeptEntryId: "kept", tokensBefore: 2000 } }; },
		summarizePortableHistory: async (input: any) => {
			portable.push(input);
			return opts.failPortable ? { ok: false, reason: "all-models-failed", usageRecords: [] }
				: { ok: true, summary: "Complete portable history", model: { provider: "local", id: "synthetic" }, usageRecords: [] };
		},
	} as never);
	const ctx: any = {
		model, hasUI: true, cwd: "/synthetic", getSystemPrompt: () => "Synthetic instructions",
		ui: { notify: (text: string) => { if (opts.uiThrows) throw new Error("UI unavailable"); notices.push(text); }, setStatus: (_key: string, text?: string) => { if (opts.uiThrows) throw new Error("UI unavailable"); statuses.push(text); } },
		modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-private-key" }) },
		sessionManager: { getBranch: () => entries, getSessionId: () => "synthetic", getSessionFile: () => undefined, buildSessionContext: () => ({ messages: [old.message, kept.message] }) },
	};
	const controller = new AbortController();
	const event = { reason: "threshold", signal: controller.signal, branchEntries: entries,
		preparation: { firstKeptEntryId: opts.opaque ? "tail" : "kept", tokensBefore: 2000, previousSummary: opts.opaque ? NATIVE_COMPACTION_FALLBACK_SUMMARY : undefined, messagesToSummarize: [old.message], turnPrefixMessages: [] } };
	globalThis.fetch = mock(async () => new Response(new ReadableStream({
		start(c) { if (opts.wire) c.enqueue(new TextEncoder().encode(opts.wire)); },
	}))) as never;
	return { entries, hooks, event, ctx, command, controller, notices, statuses, portable, get fallbacks() { return fallbacks; } };
}

test.each(["manual", "threshold", "overflow"])("%s native deadline falls back and persists sanitized branch metadata without changing context", async trigger => {
	const h = harness(); h.event.reason = trigger;
	const before = buildSessionProjection(h.entries as never).messages;
	const result = await h.hooks.get("session_before_compact")(h.event, h.ctx);
	expect(result.compaction.summary).toBe("Safe text fallback"); expect(h.fallbacks).toBe(1);
	expect(h.entries.at(-1).customType).toBe(NATIVE_ATTEMPT_ENTRY);
	expect(h.entries.at(-1).data).toMatchObject({ schemaVersion: 1, trigger, reason: "deadline-exceeded", diagnostics: { phase: "headers", outputReceived: false } });
	expect(buildSessionProjection(h.entries as never).messages).toEqual(before);
	expect(JSON.stringify(h.entries.at(-1).data)).not.toContain("synthetic-private-key");
	expect(h.statuses.some(s => s?.includes("· headers ·"))).toBe(true);
	expect(h.notices.some(s => s.includes("deadline-exceeded"))).toBe(true);
	h.hooks.get("session_tree")(); await h.command.handler("", h.ctx);
	expect(h.notices.at(-1)).toContain("restored from the active branch");
	expect(h.notices.at(-1)).toContain(`failed (deadline-exceeded) [${trigger}]`);
	expect(h.notices.at(-1)).toContain("firstByte=unknown");
});

test("explicit cancellation stops the automatic fallback chain and its live diagnostic state", async () => {
	const h = harness();
	const pending = h.hooks.get("session_before_compact")(h.event, h.ctx);
	await new Promise(resolve => setTimeout(resolve, 10));
	await h.command.handler("", h.ctx); expect(h.notices.at(-1)).toContain("Native transport in progress:");
	h.controller.abort();
	expect(await pending).toEqual({ cancel: true }); expect(h.fallbacks).toBe(0);
	expect(h.entries.at(-1).data.reason).toBe("aborted");
	await h.command.handler("", h.ctx); expect(h.notices.at(-1)).not.toContain("in progress:");
});

test("native timeout after an opaque checkpoint reconstructs hidden raw history rather than the marker", async () => {
	const h = harness({ opaque: true });
	const before = JSON.stringify(checkpoint);
	const result = await h.hooks.get("session_before_compact")(h.event, h.ctx);
	expect(result.compaction.summary).toBe("Complete portable history"); expect(h.fallbacks).toBe(0);
	expect(h.portable).toHaveLength(1);
	const messages = JSON.stringify(h.portable[0].messages);
	expect(messages).toContain("Important hidden decision"); expect(messages).toContain("Previously retained decision");
	expect(messages).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY); expect(messages).not.toContain("old-private-blob");
	expect(JSON.stringify(checkpoint)).toBe(before);
});

test("opaque timeout still fails closed when portable recovery cannot complete", async () => {
	const h = harness({ opaque: true, failPortable: true });
	expect(await h.hooks.get("session_before_compact")(h.event, h.ctx)).toEqual({ cancel: true });
	expect(h.fallbacks).toBe(0); expect(h.portable).toHaveLength(1);
});

test("metadata storage and UI failures cannot prevent safe text fallback", async () => {
	const h = harness({ persistThrows: true, uiThrows: true });
	expect((await h.hooks.get("session_before_compact")(h.event, h.ctx)).compaction.summary).toBe("Safe text fallback");
	expect(h.fallbacks).toBe(1);
});

test("idle expiration is visible while partial output enters safe fallback without a second native POST", async () => {
	const wire = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "partial-private-blob" } })}\n\n`;
	const h = harness({ idleTimeoutMs: 15, wire });
	expect((await h.hooks.get("session_before_compact")(h.event, h.ctx)).compaction.summary).toBe("Safe text fallback");
	expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	expect(h.entries.at(-1).data).toMatchObject({ reason: "incomplete-response", diagnostics: { outputReceived: true, interruption: "idle-timeout" } });
	await h.command.handler("", h.ctx); expect(h.notices.at(-1)).toContain("interrupted=idle-timeout");
	expect(JSON.stringify(h.entries.at(-1))).not.toContain("partial-private-blob");
});

const observation = { schemaVersion: 1, method: "Responses v2", outcome: "failed", reason: "deadline-exceeded", trigger: "threshold", diagnostics: { phase: "headers", attempt: 1, elapsedMs: 600_000, idleMs: 600_000, eventCount: 0, receivedBytes: 0, outputReceived: false } };
const entry = (data: unknown, id = "metadata") => ({ type: "custom", customType: NATIVE_ATTEMPT_ENTRY, data, id, parentId: null, timestamp: stamp });
test("saved diagnostics project only safe labels and counts, reject malformed data, and keep the latest twelve", () => {
	const dirty = { ...observation, reason: "secret-error-message", trigger: "https://private.invalid", privateBody: "secret", diagnostics: { ...observation.diagnostics, lastEvent: "private-event", firstByteMs: -1, interruption: "secret", privateBody: "secret" } };
	const rows = nativeAttemptHistory([entry(dirty)] as never);
	expect(rows).toHaveLength(1); expect(rows[0].reason).toBe("unclassified");
	expect(JSON.stringify(rows)).not.toContain("secret"); expect(JSON.stringify(rows)).not.toContain("private");
	const invalid = [null, { ...observation, schemaVersion: 2 }, { ...observation, method: "secret" }, { ...observation, outcome: "secret" }, { ...observation, diagnostics: null },
		{ ...observation, diagnostics: { ...observation.diagnostics, phase: "secret" } }, { ...observation, diagnostics: { ...observation.diagnostics, outputReceived: "false" } },
		...[-1, NaN, Infinity, 0.5, "1"].map(attempt => ({ ...observation, diagnostics: { ...observation.diagnostics, attempt } }))];
	expect(nativeAttemptHistory(invalid.map(data => entry(data)) as never)).toHaveLength(0);
	const many = Array.from({ length: 14 }, (_, i) => entry({ ...observation, diagnostics: { ...observation.diagnostics, elapsedMs: i, firstByteMs: 0, lastEvent: "response.created", interruption: "deadline-exceeded" } }, `meta-${i}`));
	const bounded = nativeAttemptHistory(many as never); expect(bounded).toHaveLength(12);
	expect(bounded[0].diagnostics?.elapsedMs).toBe(2); expect(bounded.at(-1)?.diagnostics?.elapsedMs).toBe(13);
});

test("progress keeps ticking without bytes, rejects work after abort, and stops its timer on dispose", async () => {
	const snapshots: any[] = [];
	const controller = new AbortController();
	const transport = new V2Transport({ signal: controller.signal, timeoutMs: 5000, onProgress: p => snapshots.push(p) });
	try {
		transport.begin(1); transport.bytes(0); transport.event("private-unrecognized-event");
		await new Promise(resolve => setTimeout(resolve, 1050));
		expect(snapshots.at(-1)).toMatchObject({ phase: "request", receivedBytes: 0, lastEvent: "other" });
		expect(snapshots.at(-1).elapsedMs).toBeGreaterThanOrEqual(900);
		controller.abort();
		expect(await transport.wait(async () => "must not run").catch(() => "aborted")).toBe("aborted");
	} finally { transport.dispose(); }
	const length = snapshots.length; await new Promise(resolve => setTimeout(resolve, 1050));
	expect(snapshots).toHaveLength(length);
}, 3500);
