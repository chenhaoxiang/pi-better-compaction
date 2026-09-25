import type {
	BeforeProviderRequestEvent,
	CompactionResult,
	ContextEvent,
	SessionEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction } from "./compact-client";
import { executeV2Compaction } from "./compact-client-v2";
import { loadExtensionConfig } from "./config";
import { redactValue, writeDebugArtifact } from "./debug";
import { findLatestCompactionEntry, isPersistedNativeCompactionEntry, resolveLatestNativeCompactionEntry } from "./details-store";
import { runNativeFallbackCompaction } from "./native-fallback";
import { reconstructPortableHistory } from "./portable-history";
import { summarizePortableHistory } from "./portable-summary";
import {
	rewriteResponsesPayloadWithNativeReplay,
	serializeLiveTailToResponsesInput,
} from "./payload-rewrite";
import { getCompactionRequestExtras, rememberRequestContext } from "./request-context-cache";
import { buildRetainedMessages } from "./retained-messages";
import {
	isResponsesCompatiblePayload,
	resolveNativeCompactionEnvironment,
	type NativeCompactionRuntime,
} from "./runtime";
import { serializeMessagesToCompactRequest, type NativeCompactionRequestBody, type ResponsesInputItem } from "./serializer";
import { mapResponsesCompactionUsage } from "./usage";
import {
	createNativeCompactionDetails,
	createNativeCompactionResult,
	DEFAULT_EXTENSION_CONFIG,
	EXTENSION_ID,
	isNativeCompactionDetails,
	NATIVE_COMPACTION_STRATEGY,
	NATIVE_COMPACTION_STRATEGY_V2,
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	type ExtensionConfig,
	type NativeCompactionDetails,
	type NativeCompactionRequestMeta,
} from "./types";

type ResponsesCompactOutcome =
	| { outcome: "success"; compaction: CompactionResult<NativeCompactionDetails> }
	| { outcome: "aborted" }
	| { outcome: "failed" };

export type ExtensionRuntimeDependencies = {
	loadExtensionConfig: typeof loadExtensionConfig;
	executeNativeCompaction: typeof executeNativeCompaction;
	executeV2Compaction: typeof executeV2Compaction;
	runNativeFallbackCompaction: typeof runNativeFallbackCompaction;
	summarizePortableHistory: typeof summarizePortableHistory;
};

const DEFAULT_DEPENDENCIES: ExtensionRuntimeDependencies = {
	loadExtensionConfig,
	executeNativeCompaction,
	executeV2Compaction,
	runNativeFallbackCompaction,
	summarizePortableHistory,
};

function buildCompactionRequestMeta(event: SessionBeforeCompactEvent): NativeCompactionRequestMeta {
	return {
		tokensBefore: event.preparation.tokensBefore,
		previousSummaryPresent: Boolean(event.preparation.previousSummary),
	};
}

function getCurrentModelDebugInfo(ctx: ExtensionContext) {
	return ctx.model
		? {
			provider: ctx.model.provider,
			id: ctx.model.id,
		}
		: undefined;
}

function getCompactionIdentityDebugInfo(entry: { details?: unknown } | undefined) {
	return isNativeCompactionDetails(entry?.details)
		? {
			provider: entry.details.provider,
			api: entry.details.api,
			model: entry.details.model,
			baseUrl: entry.details.baseUrl,
		}
		: undefined;
}

function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function notifyWarning(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${EXTENSION_ID}: ${message}`, "warning");
	}
}

function cloneOpaqueWindow(window: readonly unknown[]): unknown[] {
	return window.map((item) => structuredClone(item));
}

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	if (!guidance) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\nAdditional compaction guidance:\n${guidance}`;
}

async function runResponsesV1Compact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	runtime: NativeCompactionRuntime,
	dependencies: ExtensionRuntimeDependencies,
): Promise<ResponsesCompactOutcome> {
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});

	let requestSource: "session-context" | "non-native-session-context" | "latest-native-replay";
	let request: NativeCompactionRequestBody;
	if (latestNativeCompaction.ok) {
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		requestSource = "latest-native-replay";
		const input: ResponsesInputItem[] = [
			...(cloneOpaqueWindow(latestNativeCompaction.entry.details.compactedWindow) as ResponsesInputItem[]),
			...serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: liveTailEntries }),
		];
		request = {
			model: runtime.currentModel.id,
			input,
			instructions,
		};
	} else if (
		latestNativeCompaction.reason === "no-compaction" ||
		(latestNativeCompaction.reason === "latest-compaction-not-native" &&
			config.allowCompactionContinuityBreak)
	) {
		requestSource =
			latestNativeCompaction.reason === "no-compaction" ? "session-context" : "non-native-session-context";
		request = serializeMessagesToCompactRequest({
			model: runtime.currentModel,
			messages: ctx.sessionManager.buildSessionContext().messages,
			instructions,
		});
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v1-compact-skip",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	// Mirror the latest codex_rs CompactionInput fields captured from the most
	// recent live provider request for this model (tools, reasoning, etc.).
	const extras = getCompactionRequestExtras(runtime.model, getSessionId(ctx));
	if (extras) {
		request = { ...request, ...extras };
	}

	const compactResult = await dependencies.executeNativeCompaction({
		runtime,
		request,
		signal: event.signal,
		settings: config,
		context: ctx,
	});

	if (compactResult.ok === false) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v1-compact-failure",
				reason: compactResult.reason,
				status: compactResult.status,
				errorMessage: compactResult.errorMessage,
			},
			config,
			ctx,
		);
		return compactResult.reason === "aborted" ? { outcome: "aborted" } : { outcome: "failed" };
	}

	let details: NativeCompactionDetails;
	try {
		details = createNativeCompactionDetails({
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactedWindow: compactResult.compactedWindow,
			compactResponseId: compactResult.compactResponseId,
			createdAt: compactResult.createdAt,
			requestMeta: buildCompactionRequestMeta(event),
		});
	} catch (error) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v1-invalid-native-details",
				reason: error instanceof Error ? error.message : String(error),
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	const compaction = createNativeCompactionResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
		summary: compactResult.summaryText,
		usage: mapResponsesCompactionUsage(compactResult.response.usage, runtime.currentModel),
	});

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.v1-compact-success",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			requestSource,
			requestInputItems: request.input.length,
			requestExtras: extras ? Object.keys(extras) : [],
			compactResponseId: compactResult.compactResponseId,
			compactedItems: compactResult.compactedWindow.length,
			summaryExtracted: Boolean(compactResult.summaryText),
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		},
		config,
		ctx,
	);

	return { outcome: "success", compaction };
}

/**
 * V2 compaction: stream a Responses request with compaction_trigger appended.
 * On success, returns retained messages + encrypted compaction blob.
 */
async function runResponsesV2Compact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
	runtime: NativeCompactionRuntime,
	dependencies: ExtensionRuntimeDependencies,
): Promise<ResponsesCompactOutcome> {
	const instructions = buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions);
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});

	let requestSource: "session-context" | "non-native-session-context" | "latest-native-replay";
	let request: NativeCompactionRequestBody;
	if (latestNativeCompaction.ok) {
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		requestSource = "latest-native-replay";
		const input: ResponsesInputItem[] = [
			...(cloneOpaqueWindow(latestNativeCompaction.entry.details.compactedWindow) as ResponsesInputItem[]),
			...serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: liveTailEntries }),
		];
		request = {
			model: runtime.currentModel.id,
			input,
			instructions,
		};
	} else if (
		latestNativeCompaction.reason === "no-compaction" ||
		(latestNativeCompaction.reason === "latest-compaction-not-native" &&
			config.allowCompactionContinuityBreak)
	) {
		requestSource =
			latestNativeCompaction.reason === "no-compaction" ? "session-context" : "non-native-session-context";
		request = serializeMessagesToCompactRequest({
			model: runtime.currentModel,
			messages: ctx.sessionManager.buildSessionContext().messages,
			instructions,
		});
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v2-compact-skip",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	const extras = getCompactionRequestExtras(runtime.model, getSessionId(ctx));
	if (extras) {
		request = { ...request, ...extras };
	}

	const v2Result = await dependencies.executeV2Compaction({
		runtime,
		request,
		signal: event.signal,
		settings: config,
		context: ctx,
	});

	if (!v2Result.ok) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v2-compact-failure",
				reason: v2Result.reason,
				status: v2Result.status,
				errorMessage: v2Result.errorMessage,
			},
			config,
			ctx,
		);
		return v2Result.reason === "aborted" ? { outcome: "aborted" } : { outcome: "failed" };
	}

	// Build compacted window: retained messages + compaction blob.
	const retainedMessages = buildRetainedMessages(request.input);
	const compactedWindow = [...retainedMessages, v2Result.compactionItem];

	let details: NativeCompactionDetails;
	try {
		details = createNativeCompactionDetails(
			{
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				compactedWindow,
				compactResponseId: v2Result.responseId,
				createdAt: v2Result.createdAt,
				requestMeta: buildCompactionRequestMeta(event),
			},
			NATIVE_COMPACTION_STRATEGY_V2,
		);
	} catch (error) {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.v2-invalid-native-details",
				reason: error instanceof Error ? error.message : String(error),
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
			},
			config,
			ctx,
		);
		return { outcome: "failed" };
	}

	// V2 blob is encrypted; no summary text can be extracted.
	const compaction = createNativeCompactionResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details,
		usage: mapResponsesCompactionUsage(v2Result.usage, runtime.currentModel),
	});

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.v2-compact-success",
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			requestSource,
			requestInputItems: request.input.length,
			requestExtras: extras ? Object.keys(extras) : [],
			compactResponseId: v2Result.responseId,
			retainedMessageCount: retainedMessages.length,
			compactedItems: compactedWindow.length,
			usage: v2Result.usage,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		},
		config,
		ctx,
	);

	return { outcome: "success", compaction };
}

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	dependencies: ExtensionRuntimeDependencies,
) {
	const { config } = dependencies.loadExtensionConfig();
	if (!config.enabled) {
		return undefined;
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact",
			customInstructions: event.customInstructions,
			preparation: {
				tokensBefore: event.preparation.tokensBefore,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				previousSummaryPresent: Boolean(event.preparation.previousSummary),
				messagesToSummarizeCount: event.preparation.messagesToSummarize.length,
				turnPrefixMessagesCount: event.preparation.turnPrefixMessages.length,
			},
		},
		config,
		ctx,
	);

	if (event.signal.aborted) {
		return { cancel: true };
	}

	// Branch 1: Responses-family APIs use the native /responses/compact endpoint.
	const resolution = await resolveNativeCompactionEnvironment(ctx, {
		enabled: config.enabled,
		responsesCompactApis: config.responsesCompactApis,
	});
	if (resolution.ok) {
		let responsesOutcome: ResponsesCompactOutcome;

		if (config.compactionVersion === "v2") {
			responsesOutcome = await runResponsesV2Compact(event, ctx, config, resolution.runtime, dependencies);
		} else {
			responsesOutcome = await runResponsesV1Compact(event, ctx, config, resolution.runtime, dependencies);
		}

		if (responsesOutcome.outcome === "success") {
			return { compaction: responsesOutcome.compaction };
		}
		if (responsesOutcome.outcome === "aborted") {
			return { cancel: true };
		}
		// failed: fall through to the configured-model fallback below.
	} else {
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.responses-compact-unavailable",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
			},
			config,
			ctx,
		);
	}

	// Branch 2: try configured text models in order, without silently switching
	// channels beyond the explicit list. A repeated spec is attempted only once.
	const seenModels = new Set<string>();
	const failures: string[] = [];
	for (const modelSpec of [config.compactionModel, ...config.additionalCompactionModels]) {
		// Preserve the legacy no-model probe when no alternate was configured.
		if (!modelSpec && config.additionalCompactionModels.length > 0) continue;
		if (modelSpec && seenModels.has(modelSpec)) continue;
		if (modelSpec) seenModels.add(modelSpec);
		const fallback = await dependencies.runNativeFallbackCompaction({
			ctx,
			event,
			config: modelSpec ? { ...config, compactionModel: modelSpec } : config,
			sessionId: getSessionId(ctx),
		});
		if (fallback.ok) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`${EXTENSION_ID}: compacted with ${fallback.model.provider}/${fallback.model.id} (native method)`,
					"info",
				);
			}
			writeDebugArtifact("compaction-event", {
				event: "session_before_compact.fallback-success",
				model: fallback.model,
				usage: fallback.usage,
			}, config, ctx);
			return { compaction: fallback.result };
		}
		if (fallback.reason === "aborted") return { cancel: true };
		writeDebugArtifact("compaction-event", {
			event: "session_before_compact.fallback-skip",
			reason: fallback.reason,
			modelSpec,
			errorMessage: fallback.errorMessage,
		}, config, ctx);
		if (fallback.reason !== "same-as-current-model" && fallback.reason !== "no-model-configured") {
			const detail = fallback.errorMessage ? `: ${String(redactValue(fallback.errorMessage)).slice(0, 200)}` : "";
			failures.push(`${modelSpec} (${fallback.reason}${detail})`);
		}
	}

	if (failures.length > 0) {
		notifyWarning(ctx, `compaction models unavailable: ${failures.join(", ")}; using Pi's default compaction`);
	}
	// Branch 3: Pi's default compaction still has the full pre-compaction context.
	return undefined;
}

const PORTABLE_SUMMARY_ENTRY_TYPE = "pi-better-compaction-portable-summary";
const PORTABLE_USAGE_ENTRY_TYPE = "pi-better-compaction-portable-usage";

function latestOpaqueMarker(branch: readonly SessionEntry[]) {
	const latest = findLatestCompactionEntry(branch);
	return latest?.summary === NATIVE_COMPACTION_FALLBACK_SUMMARY ? latest : undefined;
}

function latestOpaqueCheckpoint(branch: readonly SessionEntry[]) {
	const latest = latestOpaqueMarker(branch);
	return latest && isPersistedNativeCompactionEntry(latest) ? latest : undefined;
}

function cachedPortableSummary(branch: readonly SessionEntry[], checkpointId: string, sourceDigest: string): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== PORTABLE_SUMMARY_ENTRY_TYPE ||
			!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
		const data = entry.data as Record<string, unknown>;
		if (data.compactionEntryId === checkpointId && data.sourceDigest === sourceDigest &&
			typeof data.summary === "string" && data.summary.trim()) return data.summary;
	}
	return undefined;
}

function hasCurrentPortableSummary(branch: readonly SessionEntry[], checkpoint: NonNullable<ReturnType<typeof latestOpaqueCheckpoint>>): boolean {
	const source = reconstructPortableHistory(branch, checkpoint);
	return source.ok && Boolean(cachedPortableSummary(branch, checkpoint.id, source.sourceDigest));
}

function matchesCheckpointModel(ctx: ExtensionContext, checkpoint: ReturnType<typeof latestOpaqueCheckpoint>): boolean {
	const model = ctx.model;
	const details = checkpoint?.details;
	if (!model || !details) return false;
	return model.provider === details.provider && model.api === details.api && model.id === details.model;
}

function abortOpaqueRequest(ctx: ExtensionContext, config: ExtensionConfig, reason: string): void {
	// Abort first: Pi reports and ignores hook errors, so a broken UI or debug
	// filesystem must never turn this safety gate into a normal provider request.
	ctx.abort();
	try { notifyWarning(ctx, `portable compaction unavailable (${reason}); request aborted to protect history`); }
	catch { /* The abort signal is already set. */ }
	try { writeDebugArtifact("compaction-event", { event: "opaque-continuity-blocked", reason }, config, ctx); }
	catch { /* Debug output is best-effort after the safety action. */ }
}

function payloadHasOpaquePlaceholder(payload: unknown): boolean {
	try { return JSON.stringify(payload).includes(NATIVE_COMPACTION_FALLBACK_SUMMARY); }
	catch { return true; }
}

async function handlePortableContext(
	event: ContextEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	dependencies: ExtensionRuntimeDependencies,
) {
	const { config } = dependencies.loadExtensionConfig();
	const branch = ctx.sessionManager.getBranch();
	const opaqueMarker = latestOpaqueMarker(branch);
	const checkpoint = latestOpaqueCheckpoint(branch);
	if (opaqueMarker && !checkpoint) {
		abortOpaqueRequest(ctx, config, "invalid-native-details");
		return undefined;
	}
	if (!checkpoint || matchesCheckpointModel(ctx, checkpoint)) return undefined;
	if (!config.enabled || !event.messages.some((message) =>
		message.role === "compactionSummary" && message.summary === NATIVE_COMPACTION_FALLBACK_SUMMARY,
	)) {
		abortOpaqueRequest(ctx, config, config.enabled ? "missing-placeholder-boundary" : "extension-disabled");
		return undefined;
	}

	try {
		const source = reconstructPortableHistory(branch, checkpoint);
		if (!source.ok) {
			abortOpaqueRequest(ctx, config, source.reason);
			return undefined;
		}
		let summary = cachedPortableSummary(branch, checkpoint.id, source.sourceDigest);
		if (!summary) {
			const result = await dependencies.summarizePortableHistory({
				messages: source.messages,
				ctx,
				config,
				signal: ctx.signal,
				sessionId: getSessionId(ctx),
			});
			if (!result.ok) {
				if (result.usageRecords.length > 0) {
					try { pi.appendEntry(PORTABLE_USAGE_ENTRY_TYPE, {
						compactionEntryId: checkpoint.id, usageRecords: result.usageRecords,
						reason: result.reason, createdAt: new Date().toISOString(),
					}); } catch { /* Abort still takes precedence over usage evidence. */ }
				}
				abortOpaqueRequest(ctx, config, result.reason);
				return undefined;
			}
			summary = result.summary;
			pi.appendEntry(PORTABLE_SUMMARY_ENTRY_TYPE, {
				compactionEntryId: checkpoint.id,
				sourceDigest: source.sourceDigest,
				summary,
				model: result.model,
				usageRecords: result.usageRecords,
				createdAt: new Date().toISOString(),
			});
		}
		return { messages: event.messages.map((message) =>
			message.role === "compactionSummary" && message.summary === NATIVE_COMPACTION_FALLBACK_SUMMARY
				? { ...message, summary }
				: message,
		) };
	} catch {
		// Pi reports and ignores handler exceptions. An explicit abort is required.
		abortOpaqueRequest(ctx, config, "portable-summary-error");
		return undefined;
	}
}

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	dependencies: ExtensionRuntimeDependencies,
) {
	const { config } = dependencies.loadExtensionConfig();
	const branchEntries = ctx.sessionManager.getBranch();
	const opaqueMarker = latestOpaqueMarker(branchEntries);
	const opaqueCheckpoint = latestOpaqueCheckpoint(branchEntries);
	if (opaqueMarker && !opaqueCheckpoint) {
		abortOpaqueRequest(ctx, config, "invalid-native-details");
		return undefined;
	}
	const placeholderOnWire = opaqueCheckpoint && payloadHasOpaquePlaceholder(event.payload);
	if (!config.enabled) {
		if (placeholderOnWire) abortOpaqueRequest(ctx, config, "extension-disabled-with-native-checkpoint");
		return undefined;
	}
	if (ctx.signal?.aborted) return undefined;

	// Capture compact-relevant request fields (tools, reasoning, ...) for the next
	// /responses/compact call, regardless of whether this request gets rewritten.
	if (isResponsesCompatiblePayload(event.payload)) {
		rememberRequestContext(event.payload, getSessionId(ctx));
	}

	const resolution = await resolveNativeCompactionEnvironment(
		ctx,
		{
			enabled: config.enabled,
			responsesCompactApis: config.responsesCompactApis,
		},
		event.payload,
	);
	if (resolution.ok === false) {
		if (opaqueCheckpoint && (placeholderOnWire || matchesCheckpointModel(ctx, opaqueCheckpoint) ||
			!hasCurrentPortableSummary(branchEntries, opaqueCheckpoint))) {
			abortOpaqueRequest(ctx, config, `native-environment-${resolution.reason}`);
			return undefined;
		}
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.skip",
				reason: resolution.reason,
				provider: resolution.provider,
				api: resolution.api,
				model: resolution.model,
				baseUrl: resolution.baseUrl,
				currentModel: getCurrentModelDebugInfo(ctx),
				payload: event.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	const runtime = resolution.runtime;
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});
	if (!latestNativeCompaction.ok) {
		if (opaqueCheckpoint && (placeholderOnWire || !hasCurrentPortableSummary(branchEntries, opaqueCheckpoint))) {
			abortOpaqueRequest(ctx, config, `native-replay-${latestNativeCompaction.reason}`);
			return undefined;
		}
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.no-native-compaction",
				reason: latestNativeCompaction.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				branchEntries: branchEntries.length,
				latestCompactionIndex: latestNativeCompaction.latestCompactionIndex,
				latestCompactionIdentity: getCompactionIdentityDebugInfo(latestNativeCompaction.latestCompaction),
				payload: runtime.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	const latestNativeCompactionEntry = latestNativeCompaction.entry;
	const rewrite = rewriteResponsesPayloadWithNativeReplay({
		model: runtime.currentModel,
		payload: runtime.payload,
		branchEntries,
		compactionEntry: latestNativeCompactionEntry,
	});
	if (!rewrite.ok) {
		if (opaqueCheckpoint) {
			abortOpaqueRequest(ctx, config, `native-rewrite-${rewrite.reason}`);
			return undefined;
		}
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.rewrite-failed",
				reason: rewrite.reason,
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				compactionEntryId: latestNativeCompactionEntry.id,
				parity: rewrite.parity,
				payload: runtime.payload,
			},
			config,
			ctx,
		);
		return undefined;
	}

	try {
		writeDebugArtifact(
			"provider-request",
			{
				event: "before_provider_request.native-rewrite",
				provider: runtime.provider,
				api: runtime.api,
				model: runtime.model,
				baseUrl: runtime.baseUrl,
				compactionEntryId: latestNativeCompactionEntry.id,
				boundaryIndex: rewrite.segments.boundaryIndex,
				firstKeptEntryIndex: rewrite.segments.firstKeptEntryIndex,
				originalInputItems: runtime.payload.input.length,
				rewrittenInputItems: rewrite.rewrittenPayload.input.length,
				freshPreambleItems: rewrite.segments.freshPreamble.length,
				trailingPreambleItems: rewrite.segments.trailingPreamble.length,
				compactionSummaryItems: rewrite.segments.compactionSummary.length,
				preCompactionKeptItems: rewrite.segments.preCompactionKeptWindow.input.length,
				compactedItems: rewrite.segments.compactedWindow.length,
				postCompactionTailItems: rewrite.segments.postCompactionTail.input.length,
				payload: rewrite.rewrittenPayload,
				originalPayload: runtime.payload,
			},
			config,
			ctx,
		);
	} catch { /* Diagnostic storage must not discard a valid native replay. */ }

	return rewrite.rewrittenPayload;
}

export function registerExtensionRuntime(
	pi: ExtensionAPI,
	dependencies: ExtensionRuntimeDependencies = DEFAULT_DEPENDENCIES,
): void {
	pi.on("session_start", (_event, ctx) => {
		const { config, source, warnings } = dependencies.loadExtensionConfig();
		if (!config.enabled) return;

		if (warnings.length > 0 && ctx.hasUI && config.debug) {
			ctx.ui.notify(`${EXTENSION_ID}: ${warnings[0]}`, "warning");
		}

		const artifactPath = writeDebugArtifact(
			"lifecycle",
			{
				event: "session_start",
				config,
				configSource: source,
				warnings,
			},
			config,
			ctx,
		);

		if (ctx.hasUI && (config.notifyOnLoad || config.debug)) {
			ctx.ui.notify(
				artifactPath
					? `${EXTENSION_ID} loaded • debug artifacts → ${artifactPath}`
					: `${EXTENSION_ID} loaded`,
				"info",
			);
		}
	});

	pi.on("session_before_compact", (event, ctx) =>
		handleSessionBeforeCompact(event, ctx, dependencies),
	);
	pi.on("context", async (event, ctx) => {
		try { return await handlePortableContext(event, ctx, pi, dependencies); }
		catch (error) {
			if (!event.messages.some((message) =>
				message.role === "compactionSummary" && message.summary === NATIVE_COMPACTION_FALLBACK_SUMMARY,
			)) throw error;
			abortOpaqueRequest(ctx, DEFAULT_EXTENSION_CONFIG, "unexpected-context-hook-error");
			return undefined;
		}
	});
	pi.on("cache_warming_decision", (_event, ctx) => {
		try {
			const branch = ctx.sessionManager.getBranch();
			const opaqueMarker = latestOpaqueMarker(branch);
			const checkpoint = latestOpaqueCheckpoint(branch);
			if (opaqueMarker && !checkpoint) return { action: "stop" as const };
			if (!checkpoint || matchesCheckpointModel(ctx, checkpoint)) return undefined;
			const source = reconstructPortableHistory(branch, checkpoint);
			return source.ok && cachedPortableSummary(branch, checkpoint.id, source.sourceDigest)
				? undefined : { action: "stop" as const };
		} catch { return { action: "stop" as const }; }
	});
	pi.on("before_provider_request", async (event, ctx) => {
		try { return await handleBeforeProviderRequest(event, ctx, dependencies); }
		catch (error) {
			// Pi reports handler errors but otherwise sends the unmodified payload.
			// Never permit that behavior while it still contains our opaque marker.
			if (!payloadHasOpaquePlaceholder(event.payload)) throw error;
			abortOpaqueRequest(ctx, DEFAULT_EXTENSION_CONFIG, "unexpected-provider-hook-error");
			return undefined;
		}
	});

	pi.on("session_compact_failed", (event, ctx) => {
		const { config } = dependencies.loadExtensionConfig();
		if (!config.enabled) return;

		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_compact_failed",
				reason: event.reason,
				errorMessage: event.errorMessage,
				aborted: event.aborted,
				willRetry: event.willRetry,
				fromExtension: event.fromExtension,
			},
			config,
			ctx,
		);
	});
}

export default registerExtensionRuntime;
