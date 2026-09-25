import { expect, test } from "bun:test";
import { reconstructPendingPortableHistory, reconstructPortableHistory } from "./portable-history";
import { createNativeCompactionDetails, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "./types";

const stamp = "2026-09-25T12:00:00.000Z";
const user = (id: string, parentId: string | null, text: string) => ({
	type: "message", id, parentId, timestamp: stamp,
	message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});
const native = (id: string, parentId: string, firstKeptEntryId: string) => ({
	type: "compaction", id, parentId, timestamp: stamp,
	firstKeptEntryId, summary: NATIVE_COMPACTION_FALLBACK_SUMMARY, tokensBefore: 2000,
	details: createNativeCompactionDetails({
		provider: "openai", api: "openai-responses", model: "gpt-native", baseUrl: "https://example.invalid/v1",
		compactedWindow: [{ type: "compaction", encrypted_content: "opaque-test" }],
	}),
});
const edit = (id: string, parentId: string, targetId: string, content: unknown) => ({
	type: "context_edit", id, parentId, timestamp: stamp,
	targetId, replacement: content === null ? null : { content },
});

function texts(result: ReturnType<typeof reconstructPortableHistory>): string[] {
	if (!result.ok) throw new Error(result.reason);
	return result.messages.flatMap((message) => {
		if (message.role === "compactionSummary") return [message.summary];
		if (message.role !== "user") return [];
		return typeof message.content === "string" ? [message.content] :
			message.content.filter((item) => item.type === "text").map((item) => item.text);
	});
}

test("portable source includes only the projected hidden prefix, never kept or new tail", () => {
	const old = user("old", null, "old fact");
	const kept = user("kept", "old", "recent fact");
	const checkpoint = native("native1", "kept", "kept");
	const tail = user("tail", "native1", "new fact");
	const result = reconstructPortableHistory([old, kept, checkpoint, tail] as never, checkpoint as never);
	expect(texts(result)).toEqual(["old fact"]);
	if (result.ok) expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
});

test("two native checkpoints restore all earlier raw turns without summarizing the retained tail twice", () => {
	const old = user("old", null, "old fact");
	const keptA = user("kept-a", "old", "fact a");
	const first = native("native1", "kept-a", "kept-a");
	const middle = user("middle", "native1", "fact b");
	const keptB = user("kept-b", "middle", "still visible");
	const second = native("native2", "kept-b", "kept-b");
	const tail = user("tail", "native2", "next turn");
	const result = reconstructPortableHistory([old, keptA, first, middle, keptB, second, tail] as never, second as never);
	expect(texts(result)).toEqual(["old fact", "fact a", "fact b"]);
	expect(JSON.stringify(result)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
});

test("context edits after the native checkpoint apply last-wins to hidden source", () => {
	const old = user("old", null, "old unedited");
	const second = user("second", "old", "second fact");
	const kept = user("kept", "second", "kept fact");
	const checkpoint = native("native1", "kept", "kept");
	const firstEdit = edit("edit1", "native1", "old", [{ type: "text", text: "edited fact" }]);
	const lastEdit = edit("edit2", "edit1", "old", null);
	const result = reconstructPortableHistory([old, second, kept, checkpoint, firstEdit, lastEdit] as never, checkpoint as never);
	expect(texts(result)).toEqual(["second fact"]);
});

test("a previous text compaction remains the authoritative base", () => {
	const ancient = user("ancient", null, "raw fact replaced by a text summary");
	const kept = user("kept", "ancient", "fact after text summary");
	const textCompaction = {
		type: "compaction", id: "text1", parentId: "kept", timestamp: stamp,
		firstKeptEntryId: "kept", summary: "Prior portable text summary", tokensBefore: 1000,
	};
	const afterText = user("after-text", "text1", "later fact");
	const recent = user("recent", "after-text", "recent fact");
	const checkpoint = native("native1", "recent", "recent");
	const result = reconstructPortableHistory([ancient, kept, textCompaction, afterText, recent, checkpoint] as never, checkpoint as never);
	expect(texts(result)).toEqual(["Prior portable text summary", "fact after text summary", "later fact"]);
	expect(JSON.stringify(result)).not.toContain("raw fact replaced by a text summary");
});

test("a prior text summary stays portable even when the native kept boundary precedes its entry", () => {
	const ancient = user("ancient", null, "already summarized raw fact");
	const kept = user("kept", "ancient", "still visible after native compaction");
	const textCompaction = {
		type: "compaction", id: "text1", parentId: "kept", timestamp: stamp,
		firstKeptEntryId: "kept", summary: "Essential earlier textual context", tokensBefore: 1000,
	};
	const later = user("later", "text1", "native kept tail");
	const checkpoint = native("native1", "later", "kept");
	const result = reconstructPortableHistory([ancient, kept, textCompaction, later, checkpoint] as never, checkpoint as never);
	expect(texts(result)).toEqual(["Essential earlier textual context"]);
	expect(JSON.stringify(result)).not.toContain("already summarized raw fact");
});

test("a failed second native compaction can rebuild the pending text boundary without a marker", () => {
	const old = user("old", null, "earlier hidden fact");
	const kept = user("kept", "old", "still needed fact");
	const first = native("native1", "kept", "kept");
	const newer = user("newer", "native1", "new fact to summarize");
	const nextKept = user("next-kept", "newer", "request kept verbatim");
	const result = reconstructPendingPortableHistory([old, kept, first, newer, nextKept] as never, nextKept.id, first as never);
	expect(texts(result)).toEqual(["earlier hidden fact", "still needed fact", "new fact to summarize"]);
	expect(JSON.stringify(result)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
});

test("retain-none checkpoint summarizes everything before its own entry", () => {
	const old = user("old", null, "all old fact");
	const checkpoint = native("native1", "old", "native1");
	const result = reconstructPortableHistory([old, checkpoint] as never, checkpoint as never);
	expect(texts(result)).toEqual(["all old fact"]);
});

test("forked active paths before and after a native checkpoint stay isolated", () => {
	const old = user("old", null, "branch ancestor fact");
	const kept = user("kept", "old", "kept fact");
	const checkpoint = native("native1", "kept", "kept");
	expect(reconstructPortableHistory([old, kept] as never, checkpoint as never)).toEqual({
		ok: false, reason: "checkpoint-not-on-branch",
	});
	const forkTail = user("fork-tail", "native1", "fork fact");
	expect(texts(reconstructPortableHistory([old, kept, checkpoint, forkTail] as never, checkpoint as never)))
		.toEqual(["branch ancestor fact"]);
});

test("missing retained boundary fails closed instead of summarizing an arbitrary span", () => {
	const old = user("old", null, "old fact");
	const checkpoint = native("native1", "old", "missing");
	expect(reconstructPortableHistory([old, checkpoint] as never, checkpoint as never)).toEqual({ ok: false, reason: "first-kept-entry-not-found" });
});
