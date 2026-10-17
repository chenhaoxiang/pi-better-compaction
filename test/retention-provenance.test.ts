import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as history from "../src/portable-history";
import { serializeMessagesToResponsesInput } from "../src/serializer";
import { buildRetainedMessages } from "../src/retained-messages";

const collect = (branch: unknown[]) => (history as unknown as { collectNativeRetentionMessages(entries: unknown[]): unknown[] }).collectNativeRetentionMessages(branch);
const model = { provider: "synthetic", api: "openai-responses", id: "synthetic", input: ["text"], reasoning: false };
const input = (messages: unknown[]) => serializeMessagesToResponsesInput(model as never, messages as never);

test("retention is based on real session roles rather than notification wording", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "**From a quoted document**: keep this HUMAN acceptance criterion." }], timestamp: 1 });
  manager.appendCustomMessageEntry("intercom_message", "IMPORTANT: peer status, not a human instruction", true, {});
  manager.appendCustomMessageEntry("subagent-notify", "Saved result: result.md", true, {});
  const branch = manager.getBranch();
  const full = branch.filter(entry => entry.type === "message" || entry.type === "custom_message");
  expect(full).toHaveLength(3);
  const selected = buildRetainedMessages(input(collect(branch)), 100_000);
  expect(JSON.stringify(selected)).toContain("HUMAN acceptance criterion");
  expect(JSON.stringify(selected)).not.toContain("peer status");
  expect(JSON.stringify(selected)).not.toContain("result.md");
});

test("hundreds of custom status notices cannot evict an earlier human task anchor", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "Finish the authorized release and stop when accepted." }], timestamp: 1 });
  for (let i = 0; i < 500; i++) manager.appendCustomMessageEntry("intercom_message", `status-${i}: ${"received ".repeat(60)}`, true, {});
  const before = JSON.stringify(manager.getBranch());
  const selected = buildRetainedMessages(input(collect(manager.getBranch())), 100);
  expect(selected).toHaveLength(1);
  expect(JSON.stringify(selected)).toContain("stop when accepted");
  expect(JSON.stringify(manager.getBranch())).toBe(before);
});

test("opaque checkpoints are not discarded from the persisted branch", () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Original human decision" }], timestamp: 1 });
  manager.appendCompaction("[OpenAI native compaction checkpoint]", first, 1000, {
    strategy: "openai-native-compact-v2", provider: "synthetic", api: "openai-responses", model: "synthetic", baseUrl: "https://synthetic.invalid", compactedWindow: [{ type: "compaction", encrypted_content: "unchanged-opaque-block" }],
  });
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "Latest human request" }], timestamp: 2 });
  const original = JSON.stringify(manager.getBranch());
  expect(JSON.stringify(collect(manager.getBranch()))).toContain("Original human decision");
  expect(JSON.stringify(collect(manager.getBranch()))).toContain("Latest human request");
  expect(JSON.stringify(manager.getBranch())).toBe(original);
});
