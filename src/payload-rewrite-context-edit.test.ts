import { expect, test } from "bun:test";
import { rewriteResponsesPayloadWithNativeReplay } from "./payload-rewrite";
import { serializeMessagesToResponsesInput } from "./serializer";
import { createNativeCompactionDetails, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";

const stamp = "2026-09-25T12:00:00.000Z";
const model = { provider: "openai", api: "openai-responses", id: "gpt-test", baseUrl: "https://example.invalid/v1", input: ["text"], reasoning: false };
const user = (id: string, parentId: string | null, text: string) => ({
	type: "message", id, parentId, timestamp: stamp,
	message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});
const checkpoint = {
	type: "compaction", id: "checkpoint", parentId: "kept", timestamp: stamp,
	firstKeptEntryId: "kept", summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 2000,
	details: createNativeCompactionDetails({
		provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl,
		compactedWindow: [{ type: "compaction", encrypted_content: "blob" }],
	}),
};
const summary = { role: "compactionSummary", summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 2000, timestamp: 1 };
const preamble = { role: "system", content: "Current prompt" };

function replayPayload(messages: unknown[]) {
	return {
		model: model.id,
		input: [preamble, ...serializeMessagesToResponsesInput(model as never, messages as never)],
		instructions: "Current prompt",
	};
}

test("native replay aligns and keeps an edited post-checkpoint tail", () => {
	const old = user("old", null, "hidden old fact");
	const kept = user("kept", "old", "kept fact");
	const tail = user("tail", "checkpoint", "stale tail");
	const edit = { type: "context_edit", id: "edit", parentId: "tail", timestamp: stamp,
		targetId: "tail", replacement: { content: [{ type: "text", text: "edited tail" }] } };
	const editedTail = { ...tail.message, content: [{ type: "text", text: "edited tail" }] };
	const result = rewriteResponsesPayloadWithNativeReplay({
		model: model as never,
		payload: replayPayload([summary, kept.message, editedTail]),
		branchEntries: [old, kept, checkpoint, tail, edit] as never,
		compactionEntry: checkpoint as never,
	});
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(JSON.stringify(result.rewrittenPayload.input)).toContain("edited tail");
		expect(JSON.stringify(result.rewrittenPayload.input)).not.toContain("stale tail");
		expect(result.rewrittenPayload.input).toContainEqual({ type: "compaction", encrypted_content: "blob" });
	}
});

test("native replay does not resurrect an omitted post-checkpoint turn", () => {
	const old = user("old", null, "hidden old fact");
	const kept = user("kept", "old", "kept fact");
	const tail = user("tail", "checkpoint", "abandoned attempt");
	const edit = { type: "context_edit", id: "omit", parentId: "tail", timestamp: stamp,
		targetId: "tail", replacement: null };
	const result = rewriteResponsesPayloadWithNativeReplay({
		model: model as never,
		payload: replayPayload([summary, kept.message]),
		branchEntries: [old, kept, checkpoint, tail, edit] as never,
		compactionEntry: checkpoint as never,
	});
	expect(result.ok).toBe(true);
	if (result.ok) expect(JSON.stringify(result.rewrittenPayload.input)).not.toContain("abandoned attempt");
});

test("editing pre-checkpoint history after compaction cannot replay a stale opaque blob", () => {
	const old = user("old", null, "hidden old fact");
	const kept = user("kept", "old", "original kept fact");
	const edit = { type: "context_edit", id: "edit-kept", parentId: "checkpoint", timestamp: stamp,
		targetId: "kept", replacement: { content: [{ type: "text", text: "new kept fact" }] } };
	const editedKept = { ...kept.message, content: [{ type: "text", text: "new kept fact" }] };
	const result = rewriteResponsesPayloadWithNativeReplay({
		model: model as never,
		payload: replayPayload([summary, editedKept]),
		branchEntries: [old, kept, checkpoint, edit] as never,
		compactionEntry: checkpoint as never,
	});
	expect(result).toMatchObject({ ok: false, reason: "native-history-edited-after-checkpoint" });
});
