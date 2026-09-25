import { expect, test } from "bun:test";
import { serializeLiveTailToResponsesInput } from "./payload-rewrite";

const model = { provider: "openai", api: "openai-responses", id: "gpt-test", input: ["text"], reasoning: false };
const stamp = "2026-09-25T12:00:00.000Z";
const user = (id: string, text: string) => ({ type: "message", id, timestamp: stamp, message: {
	role: "user", content: [{ type: "text", text }], timestamp: 1,
} });
const edit = (id: string, targetId: string, content: unknown) => ({
	type: "context_edit", id, timestamp: stamp, targetId,
	replacement: content === null ? null : { content },
});

test("native live-tail serialization applies replacement edits before sending to the compact endpoint", () => {
	const result = serializeLiveTailToResponsesInput({ model: model as never, entries: [
		user("tail1", "stale source"), edit("edit1", "tail1", [{ type: "text", text: "edited source" }]),
	] as never });
	expect(JSON.stringify(result)).toContain("edited source");
	expect(JSON.stringify(result)).not.toContain("stale source");
});

test("omission edits do not resurrect abandoned attempts during repeated native compaction", () => {
	const result = serializeLiveTailToResponsesInput({ model: model as never, entries: [
		user("tail1", "abandoned attempt"), edit("omit1", "tail1", null),
	] as never });
	expect(result).toEqual([]);
});

test("edited tool results retain call IDs and tool-call pairing", () => {
	const assistant = { type: "message", id: "assistant1", timestamp: stamp, message: {
		role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-test", stopReason: "toolUse", timestamp: 2,
		content: [{ type: "toolCall", id: "call1|fc1", name: "read", arguments: { path: "synthetic" } }],
	} };
	const tool = { type: "message", id: "tool1", timestamp: stamp, message: {
		role: "toolResult", toolCallId: "call1|fc1", toolName: "read", isError: false,
		content: [{ type: "text", text: "old output" }], timestamp: 3,
	} };
	const result = serializeLiveTailToResponsesInput({ model: model as never, entries: [
		assistant, tool, edit("edit1", "tool1", [{ type: "text", text: "replaced output" }]),
	] as never });
	expect(result.filter((item) => item.type === "function_call")).toHaveLength(1);
	expect(result.filter((item) => item.type === "function_call_output")).toEqual([
		{ type: "function_call_output", call_id: "call1", output: "replaced output" },
	]);
});
