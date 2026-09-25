import { expect, test } from "bun:test";
import { createNativeCompactionDetails, createNativeCompactionResult } from "./types";
import { mapResponsesCompactionUsage } from "./usage";

const model = {
	id: "gpt-synthetic",
	provider: "openai",
	api: "openai-responses",
	cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 3 },
};

test("native Responses usage maps cached and reasoning tokens with model pricing", () => {
	const usage = mapResponsesCompactionUsage({
		input_tokens: 1000,
		output_tokens: 200,
		total_tokens: 1200,
		input_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 },
		output_tokens_details: { reasoning_tokens: 30 },
	}, model as never);
	expect(usage).toMatchObject({ input: 880, output: 200, cacheRead: 100, cacheWrite: 20, reasoning: 30, totalTokens: 1200 });
	expect(usage?.cost.input).toBeCloseTo(0.00176, 8);
	expect(usage?.cost.output).toBeCloseTo(0.0016, 8);
	expect(usage?.cost.cacheRead).toBeCloseTo(0.0001, 8);
	expect(usage?.cost.cacheWrite).toBeCloseTo(0.00006, 8);
	expect(usage?.cost.total).toBeCloseTo(0.00352, 8);
});

test("native usage does not fabricate absent or invalid provider usage", () => {
	expect(mapResponsesCompactionUsage(undefined, model as never)).toBeUndefined();
	expect(mapResponsesCompactionUsage({ input_tokens: 12 }, model as never)).toBeUndefined();
	expect(mapResponsesCompactionUsage({ input_tokens: -1, output_tokens: 2 }, model as never)).toBeUndefined();
	expect(mapResponsesCompactionUsage({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 12 } }, model as never)).toBeUndefined();
});

test("compaction result forwards optional native usage to Pi", () => {
	const usage = mapResponsesCompactionUsage({ input_tokens: 100, output_tokens: 20, total_tokens: 120 }, model as never);
	const details = createNativeCompactionDetails({
		provider: "openai", api: "openai-responses", model: "gpt-synthetic", baseUrl: "https://api.openai.com/v1",
		compactedWindow: [{ type: "compaction", encrypted_content: "synthetic" }],
	});
	const result = createNativeCompactionResult({ firstKeptEntryId: "entry1", tokensBefore: 1000, details, usage });
	expect(result.usage).toEqual(usage);
});
