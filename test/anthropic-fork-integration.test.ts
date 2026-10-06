import { describe, expect, test } from "bun:test";
import { registerExtensionRuntime } from "../src/extension-runtime";
import { mapAnthropicCompactionUsage } from "../src/usage";
import { parseAnthropicCompactionResponse, buildCompactionPayload, resolveAnthropicReplay, executeAnthropicCompaction } from "../src/anthropic-compaction";
import { DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY, NATIVE_COMPACTION_STRATEGY_V2, createNativeCompactionDetails } from "../src/types";

const anthropic = { provider: "fixture-anthropic", api: "anthropic-messages", id: "claude-fixture", baseUrl: "http://127.0.0.1:9", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const openai = { ...anthropic, provider: "fixture-openai", api: "openai-responses", id: "gpt-fixture" };
const block = { type: "compaction", content: "Real plaintext history", signature: "synthetic-signature" };
const user = (id: string, text: string) => ({ type: "message", id, timestamp: "2026-10-06T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
const checkpoint = () => ({ type: "compaction", id: "opaque", timestamp: "2026-10-06T00:01:00.000Z", summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, firstKeptEntryId: "kept", tokensBefore: 1000, details: createNativeCompactionDetails({ provider: openai.provider, api: openai.api, model: openai.id, baseUrl: openai.baseUrl, compactedWindow: [{ type: "compaction", encrypted_content: "synthetic-only" }] }, NATIVE_COMPACTION_STRATEGY_V2) });

function setup(result: Record<string, unknown> = { ok: true, block }, branch: unknown[] = [], model = anthropic) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const calls = { anthropic: [] as any[], portable: [] as any[], fallback: [] as any[], abort: 0 };
  registerExtensionRuntime({ on: (name: string, handler: any) => handlers.set(name, handler), getThinkingLevel: () => "off", appendEntry() {} } as never, {
    loadExtensionConfig: () => ({ config: { ...DEFAULT_EXTENSION_CONFIG }, warnings: [] }),
    executeNativeCompaction: async () => ({ ok: false, reason: "not-used" }) as never,
    executeV2Compaction: async () => ({ ok: false, reason: "not-used" }) as never,
    executeAnthropicCompaction: async args => { calls.anthropic.push(args); return result as never; },
    summarizePortableHistory: async args => { calls.portable.push(args); return { ok: true, summary: "Recovered full raw history", model: { provider: "fixture", id: "summary" }, usageRecords: [] } as never; },
    runNativeFallbackCompaction: async args => { calls.fallback.push(args); return { ok: true, model: { provider: "fixture", id: "summary" }, result: { summary: "Fallback text", firstKeptEntryId: "kept", tokensBefore: 1000 } } as never; },
  });
  const ctx = { cwd: "/synthetic/fixture", hasUI: false, model, signal: new AbortController().signal, abort() { calls.abort++; }, getSystemPrompt: () => "synthetic system", modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-only" }) }, sessionManager: { getBranch: () => branch, getSessionId: () => "synthetic", getSessionFile: () => undefined, getSessionDir: () => undefined, buildSessionContext: () => ({ messages: [] }) } };
  const event = { signal: new AbortController().signal, preparation: { tokensBefore: 1000, firstKeptEntryId: "kept", messagesToSummarize: [user("before", "Full history before compaction").message], turnPrefixMessages: [] as unknown[], previousSummary: undefined as string | undefined } };
  return { handlers, calls, ctx, event };
}

describe("Anthropic and maintained opaque continuity", () => {
  test("native plaintext summary and actual vendor usage are retained", async () => {
    const h = setup({ ok: true, block, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } });
    const r = await h.handlers.get("session_before_compact")!(h.event, h.ctx);
    expect(r.compaction.summary).toBe(block.content);
    expect(r.compaction.usage).toMatchObject({ input: 100, output: 10, cacheRead: 20, cacheWrite: 30, totalTokens: 160 });
    expect(h.calls.anthropic).toHaveLength(1); expect(h.calls.fallback).toHaveLength(0);
  });
  test("OpenAI opaque history must be reconstructed instead of summarized by Anthropic", async () => {
    const h = setup({ ok: true, block }, [user("old", "Unabridged earlier history"), user("kept", "Current kept history"), checkpoint()]);
    h.event.preparation.previousSummary = NATIVE_COMPACTION_FALLBACK_SUMMARY;
    const r = await h.handlers.get("session_before_compact")!(h.event, h.ctx);
    expect(h.calls.anthropic).toHaveLength(0); expect(h.calls.portable).toHaveLength(1);
    expect(JSON.stringify(h.calls.portable[0].messages)).toContain("Unabridged earlier history");
    expect(JSON.stringify(h.calls.portable[0].messages)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
    expect(r.compaction.summary).toBe("Recovered full raw history");
  });
  test("opaque branch cannot be bypassed by omitting previousSummary in preparation", async () => {
    const h = setup({ ok: true, block }, [user("old", "Original history"), user("kept", "Kept"), checkpoint()]);
    await h.handlers.get("session_before_compact")!(h.event, h.ctx);
    expect(h.calls.anthropic).toHaveLength(0); expect(h.calls.portable).toHaveLength(1);
  });
  test("wire placeholder is aborted at the Anthropic boundary", async () => {
    const h = setup({ ok: true, block }, [user("kept", "Kept"), checkpoint()]);
    expect(await h.handlers.get("before_provider_request")!({ payload: { model: anthropic.id, messages: [{ role: "user", content: NATIVE_COMPACTION_FALLBACK_SUMMARY }] } }, h.ctx)).toBeUndefined();
    expect(h.calls.abort).toBe(1);
  });
  test("an unavailable identity or auth failure retains the ordered text fallback", async () => {
    const empty = setup({ ok: true, block }, [], { ...anthropic, baseUrl: "" });
    expect((await empty.handlers.get("session_before_compact")!(empty.event, empty.ctx)).compaction.summary).toBe("Fallback text");
    const h = setup(); h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "synthetic unavailable" }) as never;
    expect((await h.handlers.get("session_before_compact")!(h.event, h.ctx)).compaction.summary).toBe("Fallback text");
    expect(h.calls.anthropic).toHaveLength(0);
    const throwing = setup(); throwing.ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("synthetic auth failure"); };
    expect((await throwing.handlers.get("session_before_compact")!(throwing.event, throwing.ctx)).compaction.summary).toBe("Fallback text");
  });
  test("abort cancels without issuing another strategy", async () => {
    const h = setup({ ok: false, reason: "aborted" });
    expect(await h.handlers.get("session_before_compact")!(h.event, h.ctx)).toEqual({ cancel: true });
    expect(h.calls.fallback).toHaveLength(0);
  });
  test("a provider marker cannot become a successful Anthropic summary", async () => {
    const h = setup({ ok: true, block: { ...block, content: NATIVE_COMPACTION_FALLBACK_SUMMARY } });
    expect((await h.handlers.get("session_before_compact")!(h.event, h.ctx)).compaction.summary).toBe("Fallback text");
  });
});

describe("Anthropic provider-reported usage", () => {
  test("JSON usage and SSE input/output updates are preserved for accounting", () => {
    const json = parseAnthropicCompactionResponse(JSON.stringify({ id: "message", content: [block], stop_reason: "compaction", usage: { input_tokens: 100, output_tokens: 10 } }));
    expect(json).toMatchObject({ ok: true, usage: { input_tokens: 100, output_tokens: 10 } });
    const events = [{ type: "message_start", message: { id: "message", usage: { input_tokens: 100, cache_read_input_tokens: 20 } } }, { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "compaction" }, usage: { output_tokens: 10 } }, { type: "message_stop" }];
    const parsed = parseAnthropicCompactionResponse(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
    expect(parsed).toMatchObject({ ok: true, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20 } });
  });
  test("missing, malformed and unsafe counts are never reported as actual usage", () => {
    for (const raw of [undefined, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: "1" }, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: -1 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2 }]) expect(mapAnthropicCompactionUsage(raw, anthropic as never)).toBeUndefined();
    expect(mapAnthropicCompactionUsage({ input_tokens: 1, output_tokens: 2 }, anthropic as never)?.totalTokens).toBe(3);
  });
});

test("malformed payloads, responses and replay windows cannot become checkpoints", async () => {
  expect(buildCompactionPayload({}, {})).toBeUndefined();
  expect(parseAnthropicCompactionResponse("{broken").ok).toBe(false);
  expect(parseAnthropicCompactionResponse(JSON.stringify({ content: [block], stop_reason: "end_turn" })).ok).toBe(false);
  expect(parseAnthropicCompactionResponse(JSON.stringify({ error: { message: "synthetic rejection" } }))).toEqual({ ok: false, errorMessage: "synthetic rejection" });
  expect(parseAnthropicCompactionResponse("data: broken\n\n").ok).toBe(false);
  const unfinished = [{ type: "message_start", message: { id: "synthetic" } }, { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "compaction" } }];
  expect(parseAnthropicCompactionResponse(unfinished.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""))).toMatchObject({ ok: false, errorMessage: "incomplete compaction stream" });
  const entry = { type: "compaction", id: "bad", timestamp: "2026-10-06T00:00:00.000Z", firstKeptEntryId: "kept", tokensBefore: 10, summary: "real text", details: createNativeCompactionDetails({ provider: anthropic.provider, api: anthropic.api, model: anthropic.id, baseUrl: anthropic.baseUrl, compactedWindow: [{}] }, "anthropic-native-compact-v1" as never) };
  expect(resolveAnthropicReplay([entry] as never, { provider: anthropic.provider, api: anthropic.api, model: anthropic.id, baseUrl: anthropic.baseUrl })).toBeUndefined();
  const h = setup();
  expect(await h.handlers.get("before_provider_request")!({ payload: { model: anthropic.id, input: [] } }, h.ctx)).toBeUndefined();
});

test("transport failure, abort and missing captures fail explicitly without retries", async () => {
  const invoke = (complete: any, signal?: AbortSignal) => executeAnthropicCompaction({ model: anthropic as never, systemPrompt: "synthetic", messages: [], complete, signal });
  expect(await invoke(async () => { throw new Error("synthetic failure"); })).toMatchObject({ ok: false, reason: "request-failed" });
  const controller = new AbortController(); controller.abort();
  expect(await invoke(async () => { throw new Error("aborted"); }, controller.signal)).toEqual({ ok: false, reason: "aborted" });
  expect(await invoke(async () => ({ stopReason: "aborted" }))).toEqual({ ok: false, reason: "aborted" });
  expect(await invoke(async () => ({ stopReason: "stop" }))).toMatchObject({ ok: false, reason: "request-failed", errorMessage: "no response" });
  expect(await invoke(async (_m: unknown, _c: unknown, options: any) => options.onPayload({}))).toMatchObject({ ok: false, reason: "request-failed" });
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{broken", { status: 200 })) as typeof fetch;
    expect(await invoke(async (_m: unknown, _c: unknown, options: any) => { await options.fetch("http://127.0.0.1:9"); return { stopReason: "stop" }; })).toMatchObject({ ok: false, reason: "invalid-response" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "synthetic", content: [block], stop_reason: "compaction", usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200 })) as typeof fetch;
    expect(await invoke(async (_m: unknown, _c: unknown, options: any) => { await options.fetch("http://127.0.0.1:9"); return { stopReason: "stop" }; })).toMatchObject({ ok: true, usage: { input_tokens: 3, output_tokens: 2 } });
  } finally { globalThis.fetch = previous; }
});

test("auth-resolved endpoint governs transport and signature replay identity", async () => {
  const branch: any[] = [user("kept", "kept")]; const h = setup({ ok: true, block }, branch);
  let baseUrl = "http://127.0.0.1:8/enterprise/";
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "synthetic-only", baseUrl }) as never;
  const compacted = (await h.handlers.get("session_before_compact")!(h.event, h.ctx)).compaction;
  expect(compacted.details.baseUrl).toBe("http://127.0.0.1:8/enterprise");
  expect(h.calls.anthropic[0].model.baseUrl).toBe("http://127.0.0.1:8/enterprise");
  expect(anthropic.baseUrl).toBe("http://127.0.0.1:9");
  branch.push({ type: "compaction", id: "resolved", timestamp: "2026-10-06T00:01:00.000Z", ...compacted });
  const payload = { model: anthropic.id, messages: [{ role: "user", content: compacted.summary }] };
  expect((await h.handlers.get("before_provider_request")!({ payload }, h.ctx)).messages[0].content).toEqual([block]);
  baseUrl = "http://127.0.0.1:7/another-endpoint";
  expect(await h.handlers.get("before_provider_request")!({ payload }, h.ctx)).toBeUndefined();
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("unresolved synthetic auth"); };
  expect(await h.handlers.get("before_provider_request")!({ payload }, h.ctx)).toBeUndefined();
});

test("one-hour cache write accounting matches host pricing and rejects impossible counts", () => {
  const model = { ...anthropic, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 } };
  const raw = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 } };
  const usage = mapAnthropicCompactionUsage(raw, model as never)!;
  expect(usage.cacheWrite1h).toBe(50); expect(usage.cost.cacheWrite).toBe(200/1000000);
  for (const n of [-1,51,"50"]) expect(mapAnthropicCompactionUsage({ ...raw, cache_creation: { ephemeral_1h_input_tokens:n } }, model as never)).toBeUndefined();
});

test("SSE requires a started identified message, closed block, stop reason and terminal ordering", () => {
  const events = [{ type: "message_start", message: { id: "synthetic" } }, { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "compaction" } }, { type: "message_stop" }];
  const parse = (data: unknown[]) => parseAnthropicCompactionResponse(data.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  expect(parse(events).ok).toBe(true);
  expect(parse(events.slice(1)).ok).toBe(false);
  expect(parse([{ type: "message_start", message: {} }, ...events.slice(1)]).ok).toBe(false);
  expect(parse(events.filter(e => e.type !== "content_block_stop")).ok).toBe(false);
  expect(parse([events[0],events[0],...events.slice(1)]).ok).toBe(false);
  expect(parse([...events,{ type:"content_block_delta",index:0,delta:{type:"compaction_delta",content:"late"}}]).ok).toBe(false);
  expect(parse([events[0],{type:"content_block_stop",index:0},...events.slice(1)]).ok).toBe(false);
  expect(parse([events[0],{type:"content_block_delta",index:0,delta:{type:"compaction_delta",content:"early"}},...events.slice(1)]).ok).toBe(false);
});

test("a model disappearing at the branch boundary cannot start native compaction", async () => {
  const h = setup();let reads=0;
  Object.defineProperty(h.ctx,"model",{get:()=>++reads===1?anthropic:undefined});
  expect((await h.handlers.get("session_before_compact")!(h.event,h.ctx)).compaction.summary).toBe("Fallback text");
  expect(h.calls.anthropic).toHaveLength(0);
});
