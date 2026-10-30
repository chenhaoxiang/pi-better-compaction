import { expect, test } from "bun:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { rewriteResponsesPayloadWithNativeReplay } from "./payload-rewrite";
import { createNativeCompactionDetails, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";

const model = { provider: "synthetic-local", api: "openai-responses", id: "gpt-native", baseUrl: "https://example.invalid/v1", input: ["text", "image"], reasoning: false };
const stamp = "2026-10-30T00:00:00.000Z";
const entry = (id: string, parentId: string | null, message: unknown) => ({ type: "message", id, parentId, timestamp: stamp, message });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const custom = (id: string, parentId: string, customType: string, content: unknown) => ({
	type: "custom_message", id, parentId, timestamp: stamp, customType, content, display: true,
});
const notice = (customType: string, content: string | unknown[]) => {
	// Wire contract of pi-subagents' context_with_system provenance annotation.
	// Synthetic fixtures only: never import another extension or private session.
	const open = `<pi_subagents_notice type="${customType}" origin="automated message from the pi-subagents extension, not typed by the user">`;
	return typeof content === "string" ? `${open}\n${content}\n</pi_subagents_notice>`
		: [{ type: "text", text: `${open}\n` }, ...content, { type: "text", text: "\n</pi_subagents_notice>" }];
};

function scenario(content: string | unknown[] = "Synthetic kept result") {
	const old = entry("old", null, user("hidden decision"));
	const kept = entry("kept", "old", user("kept human instruction"));
	const keptNotice = custom("kept-notice", "kept", "subagent-notify", content);
	const checkpoint = {
		type: "compaction", id: "checkpoint", parentId: keptNotice.id, timestamp: stamp,
		firstKeptEntryId: kept.id, summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 2000,
		details: createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id,
			baseUrl: model.baseUrl, compactedWindow: [{ type: "compaction", encrypted_content: "synthetic-blob" }] }),
	};
	const tailContent = typeof content === "string" ? "Synthetic tail result" : [{ type: "text", text: "Synthetic tail result" }, ...content.slice(1)];
	const tailNotice = custom("tail-notice", checkpoint.id, "subagent-notify", tailContent);
	const otherNotice = custom("other-notice", tailNotice.id, "other-extension", "unwrapped notice");
	const tail = entry("tail", otherNotice.id, user("new human instruction"));
	const summary = { role: "compactionSummary", summary: checkpoint.summary, tokensBefore: 2000, timestamp: 1 };
	const asMessage = (item: ReturnType<typeof custom>, wrapped: boolean) => ({
		role: "custom", customType: item.customType, content: wrapped ? notice(item.customType, item.content as never) : item.content,
		display: true, timestamp: 1,
	});
	const messages = [summary, kept.message, asMessage(keptNotice, true), asMessage(tailNotice, true), asMessage(otherNotice, false), tail.message];
	const input = convertResponsesMessages(model as never, { messages: convertToLlm(messages as never) } as never,
		new Set(["openai", "openai-codex", "opencode"]), { includeSystemPrompt: false });
	const payload = { model: model.id, instructions: "fresh instructions", input: [{ role: "system", content: "fresh instructions" }, ...input], service_tier: "synthetic" };
	const branchEntries = [old, kept, keptNotice, checkpoint, tailNotice, otherNotice, tail];
	const rewrite = (next = payload) => rewriteResponsesPayloadWithNativeReplay({ model: model as never,
		payload: next, branchEntries: branchEntries as never, compactionEntry: checkpoint as never });
	return { payload, rewrite, branchEntries, checkpoint, input };
}

test.each([
	["string", "Synthetic kept result"],
	["blocks", [{ type: "text", text: "Synthetic kept result" }, { type: "image", mimeType: "image/png", data: "synthetic-image" }]],
] as const)("native replay accepts exact machine-provenance envelopes for %s custom messages", (_name, content) => {
	const s = scenario(content as never);
	const original = JSON.stringify(s.payload);
	const result = s.rewrite();
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	// Summary + kept human + kept notice are replaced, not duplicated. The
	// actual annotated tail and unrelated extension notice remain byte-for-byte.
	expect(result.rewrittenPayload).toEqual({ ...s.payload, input: [s.payload.input[0],
		{ type: "compaction", encrypted_content: "synthetic-blob" }, ...s.input.slice(3)] });
	expect(JSON.stringify(result.rewrittenPayload)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
	expect(JSON.stringify(s.payload)).toBe(original);
	expect(JSON.stringify(s.branchEntries)).not.toContain("<pi_subagents_notice");
});

test("changed human content still aborts even beside correctly annotated notices", () => {
	const s = scenario();
	const payload = structuredClone(s.payload);
	(payload.input.at(-1) as any).content[0].text = "changed human instruction";
	expect(s.rewrite(payload)).toMatchObject({ ok: false, reason: "expected-pi-replay-mismatch" });
});

test.each(["body", "type", "origin", "suffix"])("modified notice %s cannot bypass replay parity", (changed) => {
	const s = scenario();
	const payload = structuredClone(s.payload);
	const block = (payload.input[3] as any).content[0];
	const before = block.text;
	block.text = changed === "body" ? block.text.replace("Synthetic kept result", "different result")
		: changed === "type" ? block.text.replace('type="subagent-notify"', 'type="other-type"')
		: changed === "origin" ? block.text.replace("not typed by the user", "typed by the user")
		: `${block.text}\nadditional instruction`;
	expect(block.text).not.toBe(before);
	expect(s.rewrite(payload)).toMatchObject({ ok: false, reason: "expected-pi-replay-mismatch" });
});

test.each(["kept", "tail"])("omitting a %s notice is not silently accepted as an envelope change", (span) => {
	const s = scenario();
	const payload = structuredClone(s.payload);
	payload.input.splice(span === "kept" ? 3 : 4, 1);
	expect(s.rewrite(payload)).toMatchObject({ ok: false, reason: "expected-pi-replay-mismatch" });
});

test("unannotated notices still use the unchanged strict replay path", () => {
	const s = scenario();
	const payload = structuredClone(s.payload);
	(payload.input[3] as any).content[0].text = "Synthetic kept result";
	(payload.input[4] as any).content[0].text = "Synthetic tail result";
	const result = s.rewrite(payload);
	expect(result.ok).toBe(true);
	if (result.ok) expect(JSON.stringify(result.rewrittenPayload.input)).not.toContain("<pi_subagents_notice");
});

test("an empty custom block array cannot shift the replay boundary by gaining an envelope", () => {
	const s = scenario([]);
	expect(s.rewrite()).toMatchObject({ ok: false, reason: "expected-pi-replay-mismatch" });
});

test("human-authored lookalike notice envelopes are not normalized", () => {
	const s = scenario();
	const nextBranch = structuredClone(s.branchEntries);
	const keptNotice = nextBranch[2] as any;
	nextBranch[2] = entry(keptNotice.id, keptNotice.parentId, user(keptNotice.content));
	const result = rewriteResponsesPayloadWithNativeReplay({ model: model as never, payload: s.payload,
		branchEntries: nextBranch as never, compactionEntry: s.checkpoint as never });
	expect(result).toMatchObject({ ok: false, reason: "expected-pi-replay-mismatch" });
});
