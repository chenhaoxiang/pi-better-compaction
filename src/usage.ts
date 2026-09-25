import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Map actual Responses usage into Pi's session accounting shape; never synthesize missing request counts. */
export function mapResponsesCompactionUsage(raw: unknown, model: Model<Api>): Usage | undefined {
	if (!isRecord(raw) || !nonNegativeInteger(raw.input_tokens) || !nonNegativeInteger(raw.output_tokens)) {
		return undefined;
	}
	const inputDetails = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
	const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
	const cached = inputDetails.cached_tokens ?? 0;
	const cacheWrite = inputDetails.cache_write_tokens ?? 0;
	const reasoning = outputDetails.reasoning_tokens;
	const total = raw.total_tokens ?? raw.input_tokens + raw.output_tokens;
	if (!nonNegativeInteger(cached) || !nonNegativeInteger(cacheWrite) ||
		cached + cacheWrite > raw.input_tokens || !nonNegativeInteger(total) ||
		(reasoning !== undefined && (!nonNegativeInteger(reasoning) || reasoning > raw.output_tokens))) {
		return undefined;
	}

	const usage: Usage = {
		input: raw.input_tokens - cached - cacheWrite,
		output: raw.output_tokens,
		cacheRead: cached,
		cacheWrite,
		...(reasoning !== undefined ? { reasoning } : {}),
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
