import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { executeV2Compaction, type ExecuteV2CompactionOptions } from "./compact-client-v2";

const originalFetch = globalThis.fetch;
afterEach(() => { mock.restore(); globalThis.fetch = originalFetch; });
const runtime = {
	provider: "synthetic", api: "openai-responses", model: "synthetic-model",
	baseUrl: "https://example.invalid/v1", apiKey: "synthetic-secret",
	responsesUrl: "https://example.invalid/v1/responses", currentModel: { id: "synthetic-model" },
};
const event = (type: string, extra = {}) => `data: ${JSON.stringify({ type, ...extra })}\n\n`;
const blob = event("response.output_item.done", { item: { type: "compaction", encrypted_content: "private-blob" } });
const complete = event("response.completed", { response: { id: "synthetic-response" } });
const options = (extra = {}) => ({ runtime, request: { model: "synthetic-model", input: [] }, ...extra }) as ExecuteV2CompactionOptions;
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("compaction did not settle within the synthetic safety bound")), 700);
		})]);
	} finally { clearTimeout(timer!); }
}
function openResponse(wire = "", cancel?: () => unknown) {
	return new Response(new ReadableStream({
		start(controller) { if (wire) controller.enqueue(new TextEncoder().encode(wire)); },
		cancel,
	}), { headers: { "content-type": "text/event-stream" } });
}

test("expired native deadline is a failure, not a user cancellation", async () => {
	spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("expired", "TimeoutError")));
	const fetch = mock(async () => openResponse()); globalThis.fetch = fetch as never;
	const result = await executeV2Compaction(options());
	expect(result).toMatchObject({ ok: false, reason: "deadline-exceeded" });
	expect(fetch).not.toHaveBeenCalled();
});

test("deadline settles a fetch that never acknowledges cancellation without retry", async () => {
	const fetch = mock(() => new Promise<Response>(() => {})); globalThis.fetch = fetch as never;
	const result = await bounded(executeV2Compaction(options({ timeoutMs: 25, maxRetries: 2 })));
	expect(result).toMatchObject({ ok: false, reason: "deadline-exceeded", diagnostics: { phase: "request", attempt: 1, outputReceived: false } });
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("a response arriving after deadline is canceled rather than leaked or persisted", async () => {
	let deliver!: (response: Response) => void;
	globalThis.fetch = mock(() => new Promise<Response>(resolve => { deliver = resolve; })) as never;
	const result = await bounded(executeV2Compaction(options({ timeoutMs: 25 })));
	expect(result).toMatchObject({ ok: false, reason: "deadline-exceeded" });
	let canceled = false;
	deliver(openResponse(blob + complete, () => { canceled = true; return Promise.reject(new Error("synthetic cancel acknowledgement failure")); }));
	await new Promise(resolve => setTimeout(resolve, 5));
	expect(canceled).toBe(true);
});

test("deadline settles a silent open SSE reader without relying on fetch abort", async () => {
	const fetch = mock(async () => openResponse()); globalThis.fetch = fetch as never;
	const result = await bounded(executeV2Compaction(options({ timeoutMs: 25, maxRetries: 2 })));
	expect(result).toMatchObject({ ok: false, reason: "deadline-exceeded", diagnostics: { phase: "headers", receivedBytes: 0 } });
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("deadline also bounds a non-2xx response whose error body never ends", async () => {
	const fetch = mock(async () => new Response(new ReadableStream({}), { status: 503 }));
	globalThis.fetch = fetch as never;
	const result = await bounded(executeV2Compaction(options({ timeoutMs: 25, maxRetries: 2 })));
	expect(result).toMatchObject({ ok: false, reason: "deadline-exceeded", diagnostics: { phase: "headers" } });
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("caller cancellation remains immediate and wins when both signals are aborted", async () => {
	const caller = new AbortController();
	globalThis.fetch = mock(async () => openResponse()) as never;
	const timer = setTimeout(() => caller.abort(), 15);
	try {
		const result = await bounded(executeV2Compaction(options({ signal: caller.signal, timeoutMs: 200 })));
		expect(result).toMatchObject({ ok: false, reason: "aborted" });
		spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("expired", "TimeoutError")));
		expect(await executeV2Compaction(options({ signal: caller.signal }))).toMatchObject({ ok: false, reason: "aborted" });
	} finally { clearTimeout(timer); }
});

test("a timed-out partial blob is incomplete and cannot cause another native POST", async () => {
	const fetch = mock(async () => openResponse(blob)); globalThis.fetch = fetch as never;
	const result = await bounded(executeV2Compaction(options({ timeoutMs: 25, maxRetries: 2 })));
	expect(result).toMatchObject({ ok: false, reason: "incomplete-response", diagnostics: { interruption: "deadline-exceeded", outputReceived: true } });
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(result)).not.toContain("private-blob");
});

test("an announced compaction output also blocks native retry before its blob arrives", async () => {
	const wire = event("response.output_item.added", { item: { type: "compaction" } });
	const fetch = mock(async () => new Response(wire)); globalThis.fetch = fetch as never;
	const result = await executeV2Compaction(options({ maxRetries: 2 }));
	expect(result).toMatchObject({ ok: false, reason: "incomplete-response" });
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("completed SSE does not wait for a gateway reader cancel promise", async () => {
	globalThis.fetch = mock(async () => openResponse(blob + complete, () => new Promise(() => {}))) as never;
	expect((await bounded(executeV2Compaction(options()))).ok).toBe(true);
});

test.each(["data: [DONE]\n\n", event("response.incomplete")])("incomplete terminal %s exits without waiting for EOF or replaying", async terminal => {
	const fetch = mock(async () => openResponse(blob + terminal)); globalThis.fetch = fetch as never;
	const result = await bounded(executeV2Compaction(options({ maxRetries: 2 })));
	expect(result).toMatchObject({ ok: false, reason: "incomplete-response" });
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("valid SSE data fields without a space do not discard completion", async () => {
	globalThis.fetch = mock(async () => new Response((blob + complete).replaceAll("data: ", "data:"))) as never;
	expect((await executeV2Compaction(options({ maxRetries: 0 }))).ok).toBe(true);
});

test("configured idle timeout is distinct and does not retry a stalled native request", async () => {
	const fetch = mock(async () => openResponse()); globalThis.fetch = fetch as never;
	const result = await bounded(executeV2Compaction(options({ timeoutMs: 200, idleTimeoutMs: 25, maxRetries: 2 })));
	expect(result).toMatchObject({ ok: false, reason: "idle-timeout", diagnostics: { outputReceived: false } });
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("SSE heartbeat bytes reset idle time without replacing the total deadline", async () => {
	let timer: ReturnType<typeof setInterval>;
	globalThis.fetch = mock(async () => new Response(new ReadableStream({
		start(controller) {
			let ticks = 0;
			timer = setInterval(() => {
				controller.enqueue(new TextEncoder().encode(++ticks === 5 ? blob + complete : ": heartbeat\n\n"));
			}, 12);
		},
		cancel() { clearInterval(timer); },
	}))) as never;
	try {
		expect((await bounded(executeV2Compaction(options({ timeoutMs: 250, idleTimeoutMs: 45 })))).ok).toBe(true);
	} finally { clearInterval(timer!); }
});

test("live progress and final diagnostics contain only bounded transport metadata", async () => {
	const progress: any[] = [];
	globalThis.fetch = mock(async () => openResponse(event("response.created") + blob + complete)) as never;
	const result = await executeV2Compaction(options({ onProgress: (value: unknown) => progress.push(value) }));
	expect(result.ok).toBe(true);
	expect(progress.map(p => p.phase)).toEqual(expect.arrayContaining(["request", "headers", "streaming", "compaction-output", "completed"]));
	expect(result).toMatchObject({ diagnostics: { phase: "completed", attempt: 1, outputReceived: true, eventCount: 3 } });
	const safe = JSON.stringify(progress);
	for (const secret of ["synthetic-secret", "private-blob", "example.invalid", "synthetic-response"]) expect(safe).not.toContain(secret);
	expect(progress.every(p => Number.isFinite(p.elapsedMs) && p.elapsedMs >= 0)).toBe(true);
	globalThis.fetch = mock(async () => new Response(blob + complete)) as never;
	expect((await executeV2Compaction(options({ onProgress: () => { throw new Error("UI unavailable"); } }))).ok).toBe(true);
});
