import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ResponsesCompatibleRequestPayload } from "./runtime";

/**
 * pi stopped exporting the CompactionPreparation type name in 0.80.x, but it is still
 * structurally the first argument of the exported compact(). Derive it from there so we
 * track pi's shape without depending on a private export.
 */
type CompactionPreparation = Parameters<typeof compact>[0];

/**
 * Decision for T4: keep a narrow local serializer instead of importing Pi internals.
 *
 * Keep a local, version-tested serializer rather than coupling live checkpoint
 * recovery to Pi-AI's provider adapter internals. Pi's cross-model transform is
 * essential: foreign reasoning signatures cannot be replayed to the native
 * compaction endpoint, and foreign text/tool IDs must match the actual provider
 * payload when the opaque checkpoint is rewritten. Provider-free parity tests
 * compare these rules with Pi 0.87.1's converter.
 */
export const COMPACTION_SERIALIZER_STRATEGY = "local-same-model-responses-serializer" as const;

export type CompactionSerializerStrategy = typeof COMPACTION_SERIALIZER_STRATEGY;
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
	type: "input_text";
	text: string;
};

type ResponsesImageInputItem = {
	type: "input_image";
	detail: "auto";
	image_url: string;
};

export type ResponsesInputContentItem = ResponsesTextInputItem | ResponsesImageInputItem;

export type ResponsesInputMessageItem = {
	role: "user" | "developer" | "system";
	content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
	type: "message";
	role: "assistant";
	content: Array<{
		type: "output_text";
		text: string;
		annotations: [];
	}>;
	status: "completed";
	id: string;
	phase?: AssistantPhase;
};

export type ResponsesFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
};

export type ResponsesFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = Record<string, unknown>;

export type ResponsesInputItem =
	| ResponsesInputMessageItem
	| ResponsesAssistantOutputItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem
	| ResponsesReasoningItem;

export type NativeCompactionRequestBody = {
	model: string;
	input: ResponsesInputItem[];
	instructions: string;
	/**
	 * Optional passthrough fields mirroring the latest codex_rs CompactionInput.
	 * Sourced from the most recent provider request payload when available;
	 * undefined fields are omitted from the serialized JSON body.
	 */
	tools?: unknown[];
	parallel_tool_calls?: boolean;
	reasoning?: Record<string, unknown>;
	service_tier?: string;
	prompt_cache_key?: string;
	text?: Record<string, unknown>;
};

export type SerializeResponsesMessagesOptions = {
	instructions?: string;
	includeInstructionsInInput?: boolean;
};

export type ResponsesParityReport = {
	ok: boolean;
	actual: string[];
	expected: string[];
	mismatches: string[];
};

type ParsedTextSignature = {
	id: string;
	phase?: AssistantPhase;
};

const SYNTHETIC_TOOL_RESULT_TEXT = "No result provided";

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function collectCompactionWindowMessages(preparation: CompactionPreparation): AgentMessage[] {
	return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}

export function serializeCompactionPreparationToRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	preparation: CompactionPreparation;
	instructions: string;
}): NativeCompactionRequestBody {
	return serializeMessagesToCompactRequest({
		model: args.model,
		messages: collectCompactionWindowMessages(args.preparation),
		instructions: args.instructions,
	});
}

export function serializeMessagesToCompactRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
}): NativeCompactionRequestBody {
	return {
		model: args.model.id,
		input: serializeMessagesToResponsesInput(args.model, args.messages),
		instructions: sanitizeSurrogates(args.instructions),
	};
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	const llmMessages = convertToLlm(messages);
	const transformedMessages = transformMessagesForResponses(llmMessages, model);
	const input: ResponsesInputItem[] = [];

	if (options.includeInstructionsInInput && options.instructions) {
		input.push({
			role: model.reasoning ? "developer" : "system",
			content: sanitizeSurrogates(options.instructions),
		});
	}

	let messageIndex = 0;
	for (const message of transformedMessages) {
		if (message.role === "user") {
			const item = serializeUserMessage(message, model);
			if (item) {
				input.push(item);
				messageIndex++;
			}
			continue;
		}

		if (message.role === "assistant") {
			const items = serializeAssistantMessage(message, messageIndex, model);
			if (items.length > 0) {
				input.push(...items);
				messageIndex++;
			}
			continue;
		}

		if (message.role === "toolResult") {
			input.push(serializeToolResultMessage(message, model));
			messageIndex++;
			continue;
		}

		// Pi collapses system patches into the leading prompt for ordinary
		// Responses models. The current prompt is supplied separately, and the
		// collapsed patches do not advance Pi's assistant fallback-ID index.
		// Other context-only roles still advance that index.
		if (message.role !== "system") messageIndex++;
	}

	return input;
}

export function createResponsesInputParitySignature(input: readonly unknown[]): string[] {
	return input.map(describeResponsesInputItem);
}

export function compareResponsesInputParity(actual: readonly unknown[], expected: readonly unknown[]): ResponsesParityReport {
	const actualSignature = createResponsesInputParitySignature(actual);
	const expectedSignature = createResponsesInputParitySignature(expected);
	const maxLength = Math.max(actualSignature.length, expectedSignature.length);
	const mismatches: string[] = [];

	for (let index = 0; index < maxLength; index++) {
		const actualValue = actualSignature[index];
		const expectedValue = expectedSignature[index];
		if (actualValue !== expectedValue) {
			mismatches.push(`index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`);
		}
	}

	return {
		ok: mismatches.length === 0,
		actual: actualSignature,
		expected: expectedSignature,
		mismatches,
	};
}

export function compareCompactRequestToPayload(
	request: NativeCompactionRequestBody,
	payload: Pick<ResponsesCompatibleRequestPayload, "model" | "input" | "instructions">,
): ResponsesParityReport {
	const parity = compareResponsesInputParity(request.input, payload.input);
	const mismatches = [...parity.mismatches];

	if (payload.model !== request.model) {
		mismatches.unshift(`model: expected ${payload.model}, got ${request.model}`);
	}

	if ((payload.instructions ?? "") !== request.instructions) {
		mismatches.unshift("instructions: expected serialized instructions to match payload instructions");
	}

	return {
		ok: mismatches.length === 0,
		actual: parity.actual,
		expected: parity.expected,
		mismatches,
	};
}

// Pi's openai-responses adapter allows native tool-call IDs only for these
// providers. A foreign provider's call ID is normalized as one opaque string.
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

function normalizeToolCallId<TApi extends Api>(id: string, model: Model<TApi>, source: AssistantMessage): string {
	const normalizePart = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
	if (!OPENAI_TOOL_CALL_PROVIDERS.has(model.provider) || !id.includes("|")) return normalizePart(id);
	const [callId, itemId] = id.split("|");
	const foreign = source.provider !== model.provider || source.api !== model.api;
	let normalizedItemId = foreign ? `fc_${shortHash(itemId)}` : normalizePart(itemId);
	if (!normalizedItemId.startsWith("fc_")) normalizedItemId = normalizePart(`fc_${normalizedItemId}`);
	return `${normalizePart(callId)}|${normalizedItemId.slice(0, 64)}`;
}

function replaceUnsupportedImages(content: Array<TextContent | ImageContent>, placeholder: string): Array<TextContent | ImageContent> {
	const result: Array<TextContent | ImageContent> = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
			previousWasPlaceholder = true;
			continue;
		}
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}
	return result;
}

function transformMessagesForResponses<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	const toolCallIdMap = new Map<string, string>();
	const normalizedMessages = messages.map((message): Message =>
		message.content == null ? { ...message, content: [] } : message,
	);
	const imageAwareMessages = model.input.includes("image") ? normalizedMessages : normalizedMessages.map((message): Message => {
		if (message.role === "user" && Array.isArray(message.content)) {
			return { ...message, content: replaceUnsupportedImages(message.content, "(image omitted: model does not support images)") };
		}
		if (message.role === "toolResult" && Array.isArray(message.content)) {
			return { ...message, content: replaceUnsupportedImages(message.content, "(tool image omitted: model does not support images)") };
		}
		return message;
	});
	const converted = imageAwareMessages.map((message): Message => {
		if (message.role === "assistant") {
			const isSameModel = message.provider === model.provider && message.api === model.api && message.model === model.id;
			const content = (message.content ?? []).flatMap((block) => {
				if (block.type === "thinking") {
					if (block.redacted) return isSameModel ? [block] : [];
					if (isSameModel && block.thinkingSignature) return [block];
					if (!block.thinking?.trim()) return [];
					return isSameModel ? [block] : [{ type: "text" as const, text: block.thinking }];
				}
				if (block.type === "text") return isSameModel ? [block] : [{ type: "text" as const, text: block.text }];
				if (block.type === "toolCall" && !isSameModel) {
					const id = normalizeToolCallId(block.id, model, message);
					if (id !== block.id) toolCallIdMap.set(block.id, id);
					const { thoughtSignature: _signature, ...call } = block;
					return [{ ...call, id }];
				}
				return [block];
			});
			return { ...message, content };
		}
		if (message.role === "toolResult") {
			const toolCallId = toolCallIdMap.get(message.toolCallId) ?? message.toolCallId;
			return toolCallId === message.toolCallId ? message : { ...message, toolCallId };
		}
		return message;
	});

	const transformed: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const heldSystemMessages: Message[] = [];
	const closePending = () => {
		if (pendingToolCalls.length > 0) {
			transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
			pendingToolCalls = [];
			existingToolResultIds = new Set<string>();
		}
		transformed.push(...heldSystemMessages);
		heldSystemMessages.length = 0;
	};
	for (const message of converted) {
		if (message.role === "assistant") {
			closePending();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			transformed.push(message);
			const toolCalls = message.content.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set<string>();
			}
		} else if (message.role === "toolResult") {
			existingToolResultIds.add(message.toolCallId);
			transformed.push(message);
		} else if (message.role === "system" && pendingToolCalls.length > 0) {
			heldSystemMessages.push(message);
		} else {
			if (message.role === "user") closePending();
			transformed.push(message);
		}
	}
	closePending();
	return transformed;
}

function createSyntheticToolResults(
	pendingToolCalls: readonly ToolCall[],
	existingToolResultIds: ReadonlySet<string>,
): ToolResultMessage[] {
	const syntheticResults: ToolResultMessage[] = [];

	for (const toolCall of pendingToolCalls) {
		if (existingToolResultIds.has(toolCall.id)) {
			continue;
		}

		syntheticResults.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
			isError: true,
			timestamp: Date.now(),
		});
	}

	return syntheticResults;
}

function serializeUserMessage<TApi extends Api>(
	message: UserMessage,
	model: Model<TApi>,
): ResponsesInputMessageItem | undefined {
	const contentItems = normalizeUserContent(message.content).flatMap((item) => serializeUserContentItem(item, model));
	if (contentItems.length === 0) {
		return undefined;
	}

	return {
		role: "user",
		content: contentItems,
	};
}

function serializeUserContentItem<TApi extends Api>(
	item: TextContent | ImageContent,
	model: Model<TApi>,
): ResponsesInputContentItem[] {
	if (item.type === "text") {
		return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
	}

	if (!model.input.includes("image")) {
		return [];
	}

	return [
		{
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		},
	];
}

function serializeAssistantMessage<TApi extends Api>(message: AssistantMessage, messageIndex: number, model: Model<TApi>): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];
	const sameProviderAndApi = message.provider === model.provider && message.api === model.api;
	const differentModel = sameProviderAndApi && message.model !== model.id;
	const sameModel = sameProviderAndApi && message.model === model.id;
	let textBlockIndex = 0;

	for (const block of message.content) {
		if (block.type === "thinking") {
			const reasoningItem = parseReasoningItem(block);
			if (reasoningItem) items.push(reasoningItem);
			continue;
		}

		if (block.type === "text") {
			const signature = parseTextSignature(block.textSignature);
			const fallbackId = textBlockIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textBlockIndex}`;
			textBlockIndex++;
			items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
				id: normalizeAssistantMessageId(signature?.id, fallbackId),
				phase: signature?.phase,
			});
			continue;
		}

		const [callId, rawItemId] = block.id.split("|");
		// Pi omits foreign/different-model item IDs that cannot safely pair
		// with a reasoning item from the original response.
		const itemId = (differentModel && rawItemId?.startsWith("fc_")) || !rawItemId?.startsWith("fc_")
			? undefined : rawItemId;
		items.push({
			type: "function_call",
			id: itemId,
			call_id: callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
			...(sameModel && block.namespace !== undefined ? { namespace: block.namespace } : {}),
		});
	}

	return items;
}

function serializeToolResultMessage<TApi extends Api>(
	message: ToolResultMessage,
	model: Model<TApi>,
): ResponsesFunctionCallOutputItem {
	const [callId] = (message.toolCallId ?? "").split("|");
	const contentItems = normalizeToolResultContent(message.content);
	const textOutput = contentItems
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");
	const hasImages = contentItems.some((item) => item.type === "image");
	const hasText = textOutput.length > 0;

	if (hasImages && model.input.includes("image")) {
		const output: ResponsesInputContentItem[] = [];
		if (hasText) {
			output.push({ type: "input_text", text: textOutput });
		}
		for (const item of contentItems) {
			if (item.type !== "image") {
				continue;
			}
			output.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${item.mimeType};base64,${item.data}`,
			});
		}
		return {
			type: "function_call_output",
			call_id: callId,
			output,
		};
	}

	return {
		type: "function_call_output",
		call_id: callId,
		output: hasText ? textOutput : hasImages ? "(see attached image)" : "(no tool output)",
	};
}

function normalizeUserContent(content: UserMessage["content"]): Array<TextContent | ImageContent> {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Session files are parsed without validation and older Pi versions persisted
 * tool results with string `content`, so normalize defensively instead of
 * assuming an array (mirrors normalizeUserContent above).
 */
function normalizeToolResultContent(
	content: ToolResultMessage["content"] | string | null | undefined,
): Array<TextContent | ImageContent> {
	if (typeof content === "string") {
		return content.length > 0 ? [{ type: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	return content.filter(
		(item): item is TextContent | ImageContent =>
			item != null && (item.type === "text" || item.type === "image"),
	);
}

function parseReasoningItem(block: ThinkingContent): ResponsesReasoningItem | undefined {
	if (!block.thinkingSignature) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(block.thinkingSignature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as ResponsesReasoningItem;
	} catch {
		return undefined;
	}
}

function parseTextSignature(signature: string | undefined): ParsedTextSignature | undefined {
	if (!signature) {
		return undefined;
	}

	if (!signature.startsWith("{")) {
		return { id: signature };
	}

	try {
		const parsed = JSON.parse(signature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}

		const record = parsed as Record<string, unknown>;
		if (record.v !== 1 || typeof record.id !== "string") {
			return { id: signature };
		}

		return {
			id: record.id,
			phase:
				record.phase === "commentary" || record.phase === "final_answer"
					? record.phase
					: undefined,
		};
	} catch {
		return { id: signature };
	}
}

// Matches Pi-AI 0.87.1's deterministic shortHash for oversized or foreign IDs.
function shortHash(value: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < value.length; index++) {
		const char = value.charCodeAt(index);
		h1 = Math.imul(h1 ^ char, 2654435761);
		h2 = Math.imul(h2 ^ char, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function normalizeAssistantMessageId(id: string | undefined, fallbackId: string): string {
	if (!id) return fallbackId;
	return id.length <= 64 ? id : `msg_${shortHash(id)}`;
}

function isToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

function describeResponsesInputItem(item: unknown): string {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return typeof item;
	}

	const record = item as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === "message") {
		const phase =
			record.phase === "commentary" || record.phase === "final_answer"
				? `:${record.phase}`
				: "";
		return `message:${typeof record.role === "string" ? record.role : "unknown"}${phase}`;
	}

	if (type === "function_call") {
		return `function_call:${typeof record.name === "string" ? record.name : "unknown"}`;
	}

	if (type === "function_call_output") {
		return "function_call_output";
	}

	if (type === "reasoning") {
		return "reasoning";
	}

	if (typeof record.role === "string") {
		const content = Array.isArray(record.content) ? `[${record.content.length}]` : "";
		return `input:${record.role}${content}`;
	}

	return type ? `item:${type}` : "object";
}
