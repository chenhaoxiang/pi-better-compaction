import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { serializeMessagesToResponsesInput } from "../../src/serializer";

// Separate process: bunfig's test/setup.ts mocks convertToLlm in unit tests.
const messages = [
	{ role: "system", content: "synthetic persisted system patch", timestamp: 1 },
	{ role: "user", content: "synthetic question", timestamp: 2 },
	{ role: "toolResult", toolCallId: "call-1|fc-1", toolName: "read", isError: false,
		content: "synthetic legacy result", timestamp: 3 },
];
const actualConverted = convertToLlm(messages as never);
if (!actualConverted.some((message) => message.role === "system" && typeof message.content === "string")) {
	throw new Error("Expected the installed Pi converter to preserve a string system message");
}
const model = { provider: "openai", api: "openai-responses", id: "gpt-synthetic", input: ["text"], reasoning: false };
const input = serializeMessagesToResponsesInput(model as never, messages as never);
const rendered = JSON.stringify(input);
if (rendered.includes("synthetic persisted system patch") ||
	!rendered.includes("synthetic question") || !rendered.includes("synthetic legacy result")) {
	throw new Error("Extension serialization differs from the real Pi message shape");
}
console.log(JSON.stringify({ passed: true, inputItems: input.length }));
