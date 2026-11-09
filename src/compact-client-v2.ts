/**
 * V2 compaction streaming client.
 *
 * Sends a Responses API request with a `compaction_trigger` input item appended,
 * streams the SSE response, and collects the encrypted `compaction` output blob.
 *
 * This is the pi extension equivalent of codex-rs `compact_remote_v2.rs`.
 */

import { writeDebugArtifact } from "./debug";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";
import { toHeaders } from "./shared-headers";
import type { ArtifactContext, ExtensionConfig } from "./types";
import { V2Transport, type V2CompactionDiagnostics } from "./v2-transport";

// ── Types ──────────────────────────────────────────────────────────────

export type CompactionItem = {
	type: "compaction";
	id?: string;
	encrypted_content: string;
};

export type V2CompactionUsage = {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	[key: string]: unknown;
};

export type V2CompactionSuccess = {
	ok: true;
	compactionItem: CompactionItem;
	responseId?: string;
	createdAt?: string;
	usage?: V2CompactionUsage;
};

export type V2CompactionFailureReason =
	| "aborted"
	| "deadline-exceeded"
	| "idle-timeout"
	| "network-error"
	| "non-2xx"
	| "provider-failed"
	| "incomplete-response"
	| "no-compaction-output"
	| "multiple-compaction-outputs"
	| "stream-parse-error"
	| "retries-exhausted";

export type V2CompactionFailure = {
	ok: false;
	reason: V2CompactionFailureReason;
	status?: number;
	errorMessage?: string;
};

export type V2CompactionResult = (V2CompactionSuccess | V2CompactionFailure) & { diagnostics?: V2CompactionDiagnostics };

export type ExecuteV2CompactionOptions = {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequestBody;
	signal?: AbortSignal;
	maxRetries?: number;
	/** Operation-wide deadline, not renewed by retries. Default remains 600 seconds. */
	timeoutMs?: number;
	/** Optional inactivity bound; zero/omitted preserves long silent native requests. */
	idleTimeoutMs?: number;
	onProgress?: (progress: V2CompactionDiagnostics) => void;
	trigger?: "manual" | "threshold" | "overflow";
	settings?: ExtensionConfig;
	context?: ArtifactContext;
};

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
const SSE_ACCEPT = "text/event-stream";
// Copilot rejects compaction_trigger with a smaller explicit output ceiling.
const COPILOT_COMPACTION_OUTPUT_CEILING = 20_000;

// ── Helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCompactionItem(item: unknown): item is CompactionItem {
	return (
		isRecord(item) &&
		(item.type === "compaction" || item.type === "compaction_summary") &&
		typeof item.encrypted_content === "string" &&
		item.encrypted_content.length > 0
	);
}

function writeV2Artifact(
	data: unknown,
	settings: ExtensionConfig | undefined,
	context: ArtifactContext | undefined,
): void {
	if (!settings || !context) return;
	writeDebugArtifact("compact-response", data, settings, context);
}

// ── SSE stream processing ──────────────────────────────────────────────

type StreamCollectionResult =
	| { ok: true; compactionItems: CompactionItem[]; responseId?: string; createdAt?: string; usage?: V2CompactionUsage }
	| { ok: false; reason: V2CompactionFailureReason; errorMessage?: string };

/**
 * Read an SSE stream from a fetch Response and collect compaction output items.
 *
 * Expected SSE events:
 * - `response.output_item.done` with a compaction item in `item`
 * - `response.completed` with `response.id`, `response.usage`, `response.created_at`
 * - `response.failed` / `error` for server-side errors
 */
function interruptionReason(transport: V2Transport, error?: unknown): V2CompactionFailureReason | undefined {
	const reason = transport.interruption(error);
	return reason && reason !== "aborted" && transport.outputReceived ? "incomplete-response" : reason;
}

async function collectStreamOutput(response: Response, transport: V2Transport): Promise<StreamCollectionResult> {
	const { signal } = transport;
	const body = response.body;
	if (!body) {
		return { ok: false, reason: "stream-parse-error", errorMessage: "Response body is null" };
	}

	const compactionItems: CompactionItem[] = [];
	let responseId: string | undefined;
	let createdAt: string | undefined;
	let usage: V2CompactionUsage | undefined;
	let serverError: string | undefined;
	let completed = false;
	let incompleteTerminal = false;

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		stream: while (true) {
			signal.throwIfAborted();
			const { done, value } = await transport.wait(() => reader.read());
			signal.throwIfAborted();
			if (done) break;
			transport.bytes(value.byteLength);

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			// Keep the last incomplete line in the buffer.
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith(":")) continue;
				if (!trimmed.startsWith("data:")) continue;

				const jsonStr = trimmed.slice(5).trimStart();
				if (jsonStr === "[DONE]") {
					transport.event("[DONE]");
					incompleteTerminal = true;
					break stream;
				}

				let event: Record<string, unknown>;
				try {
					event = JSON.parse(jsonStr);
					if (!isRecord(event)) continue;
				} catch {
					continue;
				}

				const eventType = event.type;
				transport.event(eventType);
				if ((eventType === "response.output_item.added" || eventType === "response.output_item.done") &&
					isRecord(event.item) && (event.item.type === "compaction" || event.item.type === "compaction_summary")) {
					// An announced output is already ambiguous billed work, even before the blob arrives.
					transport.output();
				}
				if (eventType === "response.incomplete") {
					incompleteTerminal = true;
					break stream;
				}

				if (eventType === "response.output_item.done") {
					const item = event.item;
					if (isCompactionItem(item)) {
						compactionItems.push({
							type: "compaction",
							id: typeof item.id === "string" ? item.id : undefined,
							encrypted_content: item.encrypted_content,
						});
					}
					continue;
				}

				if (eventType === "response.completed") {
					completed = true;
					transport.completed();
					const resp = event.response;
					if (isRecord(resp)) {
						responseId = typeof resp.id === "string" ? resp.id : undefined;
						createdAt = normalizeTimestamp(resp.created_at);
						if (isRecord(resp.usage)) {
							usage = resp.usage as V2CompactionUsage;
						}
					}
					break stream;
				}

				if (eventType === "response.failed" || eventType === "error") {
					const errorObj = event.error ?? event;
					serverError = isRecord(errorObj)
						? (typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj))
						: String(errorObj);
					break stream;
				}
			}
		}
	} catch (error) {
		const interrupted = interruptionReason(transport, error);
		if (interrupted) return { ok: false, reason: interrupted };
		return {
			ok: false,
			reason: transport.outputReceived ? "incomplete-response" : "stream-parse-error",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	} finally {
		// A gateway's cancellation acknowledgement must not keep a terminal operation open.
		void reader.cancel().catch(() => {});
		try { reader.releaseLock(); } catch { /* A pending read is canceled above. */ }
	}

	if (serverError !== undefined) {
		return { ok: false, reason: "provider-failed", errorMessage: serverError };
	}
	if (!completed) {
		return {
			ok: false,
			reason: transport.outputReceived || incompleteTerminal ? "incomplete-response" : "stream-parse-error",
			errorMessage: "Responses stream ended before response.completed",
		};
	}

	return { ok: true, compactionItems, responseId, createdAt, usage };
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(ms).toISOString();
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value.trim());
		return Number.isNaN(parsed) ? value.trim() : new Date(parsed).toISOString();
	}
	return undefined;
}

// ── Single attempt ─────────────────────────────────────────────────────

async function readErrorText(response: Response, transport: V2Transport): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { done, value } = await transport.wait(() => reader.read());
			if (done) return text + decoder.decode();
			transport.bytes(value.byteLength);
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		void reader.cancel().catch(() => {});
		try { reader.releaseLock(); } catch { /* A pending read is canceled above. */ }
	}
}

async function executeV2Attempt(
	url: string,
	requestBody: unknown,
	headers: Record<string, string>,
	transport: V2Transport,
): Promise<{ response?: Response; result?: StreamCollectionResult; failure?: V2CompactionFailure }> {
	const { signal } = transport;

	let response: Response;
	try {
		response = await transport.wait(async () => {
			const received = await fetch(url, {
				method: "POST", headers, body: JSON.stringify(requestBody), signal,
			});
			if (signal.aborted) {
				// A non-cooperative fetch may resolve after the caller has already returned.
				void received.body?.cancel().catch(() => {});
				signal.throwIfAborted();
			}
			return received;
		});
		transport.headers();
	} catch (error) {
		const interrupted = interruptionReason(transport, error);
		if (interrupted) return { failure: { ok: false, reason: interrupted } };
		return {
			failure: {
				ok: false,
				reason: "network-error",
				errorMessage: error instanceof Error ? error.message : String(error),
			},
		};
	}

	if (!response.ok) {
		let errorMessage: string | undefined;
		try {
			const text = await readErrorText(response, transport);
			if (text.trim()) {
				try {
					const json = JSON.parse(text);
					errorMessage = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string"
						? json.error.message
						: text;
				} catch {
					errorMessage = text;
				}
			}
		} catch (error) {
			const interrupted = interruptionReason(transport, error);
			if (interrupted) return { response, failure: { ok: false, reason: interrupted } };
		}
		return {
			response,
			failure: {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				errorMessage,
			},
		};
	}

	const result = await collectStreamOutput(response, transport);
	return { response, result };
}

// ── Retryable errors ───────────────────────────────────────────────────

function isRetryable(result: V2CompactionFailure): boolean {
	return result.reason === "network-error" || result.reason === "stream-parse-error";
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Execute a V2 compaction request.
 *
 * Builds a Responses API streaming request with a `compaction_trigger` appended
 * to the input, streams the SSE response, and collects the compaction blob.
 *
 * Retries recoverable failures up to `maxRetries` times (default 2).
 *
 * Copilot routes in Pi 0.84.4; tested means live native compaction and replay.
 *
 * | Provider (via Copilot) | API | Tested |
 * | --- | --- | --- |
 * | OpenAI (Astra) | Responses | Yes |
 * | xAI (Grok 4.6) | Responses | Failed (HTTP 422) |
 * | Google (Gemini) | Chat Completions | No; outside this path |
 * | Anthropic (Opus) | Messages | No; outside this path |
 */
export async function executeV2Compaction(
	options: ExecuteV2CompactionOptions,
): Promise<V2CompactionResult> {
	const transport = new V2Transport({
		signal: options.signal, timeoutMs: options.timeoutMs,
		idleTimeoutMs: options.idleTimeoutMs ?? options.settings?.nativeV2IdleTimeoutMs,
		onProgress: options.onProgress,
	});
	try {
		const result = await executeWithTransport(options, transport);
		return { ...result, diagnostics: transport.snapshot() };
	} finally { transport.dispose(); }
}

async function executeWithTransport(options: ExecuteV2CompactionOptions, transport: V2Transport): Promise<V2CompactionSuccess | V2CompactionFailure> {
	const { runtime, request, settings, context } = options;
	const { signal } = transport;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

	const headers = toHeaders(runtime, SSE_ACCEPT, request.input);
	const url = runtime.responsesUrl;

	// Build request body: input + compaction_trigger, stream=true.
	const requestBody = {
		...request,
		input: [...request.input, { type: "compaction_trigger" }],
		store: false,
		stream: true,
		...(runtime.provider === "github-copilot" ? {
			max_output_tokens: COPILOT_COMPACTION_OUTPUT_CEILING,
		} : {}),
	};

	let lastFailure: V2CompactionFailure | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (signal?.aborted) {
			const aborted: V2CompactionFailure = { ok: false, reason: interruptionReason(transport)! };
			writeV2Artifact(
				{ request: { url, headers, body: requestBody }, attempt, outcome: aborted },
				settings,
				context,
			);
			return aborted;
		}

		transport.begin(attempt + 1);
		const { result, failure } = await executeV2Attempt(url, requestBody, headers, transport);

		if (failure) {
			lastFailure = failure;
			if (!isRetryable(failure) || attempt >= maxRetries) {
				writeV2Artifact(
					{ request: { url, headers, body: requestBody }, attempt, outcome: failure },
					settings,
					context,
				);
				return failure;
			}
			continue;
		}

		if (!result) {
			// Should not happen, but guard.
			lastFailure = { ok: false, reason: "stream-parse-error", errorMessage: "No result from attempt" };
			continue;
		}

		if (!result.ok) {
			lastFailure = { ok: false, reason: result.reason, errorMessage: result.errorMessage };
			if (result.reason === "aborted" || !isRetryable(lastFailure) || attempt >= maxRetries) {
				writeV2Artifact(
					{ request: { url, headers, body: requestBody }, attempt, outcome: lastFailure },
					settings,
					context,
				);
				return lastFailure;
			}
			continue;
		}

		// Stream collected successfully. Validate compaction output.
		if (result.compactionItems.length === 0) {
			const noOutput: V2CompactionFailure = {
				ok: false,
				reason: "no-compaction-output",
			};
			writeV2Artifact(
				{ request: { url, headers, body: requestBody }, attempt, outcome: noOutput },
				settings,
				context,
			);
			return noOutput;
		}

		if (result.compactionItems.length > 1) {
			const multiOutput: V2CompactionFailure = {
				ok: false,
				reason: "multiple-compaction-outputs",
				errorMessage: `Expected 1 compaction item, got ${result.compactionItems.length}`,
			};
			writeV2Artifact(
				{ request: { url, headers, body: requestBody }, attempt, outcome: multiOutput },
				settings,
				context,
			);
			return multiOutput;
		}

		const success: V2CompactionSuccess = {
			ok: true,
			compactionItem: result.compactionItems[0]!,
			responseId: result.responseId,
			createdAt: result.createdAt,
			usage: result.usage,
		};

		writeV2Artifact(
			{
				request: { url, headers, body: requestBody },
				attempt,
				outcome: {
					ok: true,
					responseId: success.responseId,
					createdAt: success.createdAt,
					compactionItemId: success.compactionItem.id,
					usage: success.usage,
				},
			},
			settings,
			context,
		);

		return success;
	}

	// All retries exhausted.
	const exhausted: V2CompactionFailure = {
		ok: false,
		reason: "retries-exhausted",
		errorMessage: lastFailure?.errorMessage ?? "All retry attempts failed",
	};
	writeV2Artifact(
		{ request: { url, headers, body: requestBody }, maxRetries, outcome: exhausted },
		settings,
		context,
	);
	return exhausted;
}
