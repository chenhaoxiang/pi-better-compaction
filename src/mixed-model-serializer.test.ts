import { expect, test } from "bun:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { rewriteResponsesPayloadWithNativeReplay } from "./payload-rewrite";
import { serializeMessagesToCompactRequest, serializeMessagesToResponsesInput } from "./serializer";
import { createNativeCompactionDetails, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";

// Match the provider set used by Pi 0.87.1's openai-responses adapter. The
// converter is a test oracle only; production must not import its internals.
const toolCallProviders = new Set(["openai", "openai-codex", "opencode"]);
const target = {
	provider: "codex-local-8319", api: "openai-responses", id: "gpt-6-sol",
	baseUrl: "https://example.invalid/v1", input: ["text"], reasoning: false,
};
const stamp = "2026-09-26T01:00:00.000Z";
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const kimi = {
	role: "assistant", provider: "codex-local", api: "openai-responses", model: "kimi-k3",
	stopReason: "toolUse", timestamp: 2,
	content: [
		{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({
			type: "reasoning", id: "rs_kimi", status: "completed", encrypted_content: "synthetic-encrypted",
		}) },
		{ type: "text", text: "Working", textSignature: JSON.stringify({ v: 1, id: "msg_kimi" }) },
		{ type: "toolCall", id: "call_kimi|fc_kimi", name: "read", arguments: { path: "synthetic" } },
	],
};
const result = {
	role: "toolResult", toolCallId: "call_kimi|fc_kimi", toolName: "read", isError: false,
	content: [{ type: "text", text: "ok" }], timestamp: 3,
};
const mixed = [user("Start"), kimi, result, user("Continue")];
const piInput = (messages: unknown[]) => convertResponsesMessages(
	target as never, { messages: convertToLlm(messages as never) } as never,
	toolCallProviders, { includeSystemPrompt: false },
);

test("mixed Kimi history matches Pi's cross-provider Responses converter", () => {
	const expected = piInput(mixed);
	const actual = serializeMessagesToResponsesInput(target as never, mixed as never);
	expect(actual).toEqual(expected);
	expect(actual.some((item) => item.type === "reasoning" && "status" in item)).toBe(false);
});

test("V2 compact never replays a foreign reasoning output item", () => {
	const request = serializeMessagesToCompactRequest({
		model: target as never, messages: mixed as never, instructions: "Synthetic prompt",
	});
	expect(request.input).toEqual(piInput(mixed));
	expect(request.input.some((item) => item.type === "reasoning" && "status" in item)).toBe(false);
});

test("native checkpoint replays after a Kimi turn using Pi's actual payload shape", () => {
	const old = { type: "message", id: "old", parentId: null, timestamp: stamp, message: user("Hidden") };
	const kept = { type: "message", id: "kept", parentId: "old", timestamp: stamp, message: user("Kept") };
	const checkpoint = {
		type: "compaction", id: "checkpoint", parentId: "kept", timestamp: stamp,
		firstKeptEntryId: "kept", summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 3000,
		details: createNativeCompactionDetails({
			provider: target.provider, api: target.api, model: target.id, baseUrl: target.baseUrl,
			compactedWindow: [{ type: "compaction", encrypted_content: "synthetic-blob" }],
		}),
	};
	const patch = { type: "message", id: "system-patch", parentId: "checkpoint", timestamp: stamp,
		message: { role: "system", content: "Updated prompt", timestamp: 2 } };
	const assistant = { type: "message", id: "kimi", parentId: "system-patch", timestamp: stamp, message: kimi };
	const tool = { type: "message", id: "result", parentId: "kimi", timestamp: stamp, message: result };
	const next = { type: "message", id: "next", parentId: "result", timestamp: stamp, message: user("Continue") };
	const summary = { role: "compactionSummary", summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 3000, timestamp: 1 };
	const payload = {
		model: target.id, instructions: "Synthetic prompt",
		input: [{ role: "system", content: "Synthetic prompt" }, ...piInput([summary, kept.message, patch.message, kimi, result, next.message])],
	};
	const rewritten = rewriteResponsesPayloadWithNativeReplay({
		model: target as never, payload: payload as never,
		branchEntries: [old, kept, checkpoint, patch, assistant, tool, next] as never,
		compactionEntry: checkpoint as never,
	});
	expect(rewritten.ok).toBe(true);
	if (rewritten.ok) {
		expect(rewritten.rewrittenPayload.input).toContainEqual({
			type: "compaction", encrypted_content: "synthetic-blob",
		});
		expect(JSON.stringify(rewritten.rewrittenPayload.input)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
	}
});

test("foreign tools also match Pi for providers retaining Responses item IDs", () => {
	const openai = { ...target, provider: "openai" };
	const actual = serializeMessagesToResponsesInput(openai as never, mixed as never);
	const expected = convertResponsesMessages(
		openai as never, { messages: convertToLlm(mixed as never) } as never,
		toolCallProviders, { includeSystemPrompt: false },
	);
	expect(actual).toEqual(expected);
});

test("same-provider model changes normalize tool IDs but never reuse foreign reasoning", () => {
	const source = { ...kimi, provider: target.provider, model: "other-model" };
	const messages = [source, result];
	const expected = piInput(messages);
	const actual = serializeMessagesToResponsesInput(target as never, messages as never);
	expect(actual).toEqual(expected);
});

test("foreign visible thinking is converted to text, while same-model signed reasoning survives", () => {
	const visible = { ...kimi, content: [
		{ type: "thinking", thinking: "visible synthetic thought", thinkingSignature: JSON.stringify({
			type: "reasoning", id: "rs_foreign", status: "completed", encrypted_content: "synthetic",
		}) },
		{ type: "text", text: "answer" },
	] };
	const native = { ...visible, provider: target.provider, model: target.id };
	for (const messages of [[visible], [native]]) {
		expect(serializeMessagesToResponsesInput(target as never, messages as never)).toEqual(piInput(messages));
	}
});

test("Pi-compatible text fallback IDs cover missing, malformed, and oversized signatures", () => {
	const longId = "msg_" + "x".repeat(100);
	const messages = [{ ...kimi, provider: target.provider, model: target.id, content: [
		{ type: "text", text: "one" },
		{ type: "text", text: "two", textSignature: "{broken" },
		{ type: "text", text: "three", textSignature: JSON.stringify({ v: 2, id: "unknown" }) },
		{ type: "text", text: "four", textSignature: JSON.stringify({ v: 1, id: longId }) },
	] }];
	expect(serializeMessagesToResponsesInput(target as never, messages as never)).toEqual(piInput(messages));
});

test("a system patch between a tool call and its result cannot synthesize a duplicate output", () => {
	const messages = [kimi, { role: "system", content: "Synthetic patch", timestamp: 3 }, result];
	const actual = serializeMessagesToResponsesInput(target as never, messages as never);
	expect(actual.filter((item) => item.type === "function_call_output")).toHaveLength(1);
});

test("non-vision cross-model history keeps Pi's image-omission placeholders", () => {
	const messages = [
		{ role: "user", content: [
			{ type: "text", text: "Question" }, { type: "image", mimeType: "image/png", data: "synthetic" },
		], timestamp: 1 },
		{ role: "toolResult", toolCallId: "call|fc", toolName: "read", isError: false,
			content: [{ type: "image", mimeType: "image/png", data: "synthetic" }], timestamp: 2 },
	];
	expect(serializeMessagesToResponsesInput(target as never, messages as never)).toEqual(piInput(messages));
});
