import { isAbortError } from "./shared-headers";

export const NATIVE_V2_TIMEOUT_MS = 600_000;
export const NATIVE_ATTEMPT_ENTRY = "pi-better-compaction-native-attempt";
export const V2_PHASES = ["request", "headers", "streaming", "compaction-output", "completed"] as const;
export const V2_EVENTS = ["response.created", "response.in_progress", "response.output_item.added", "response.output_item.done", "response.completed", "response.failed", "response.incomplete", "error", "[DONE]", "other"] as const;
export type V2Interruption = "aborted" | "deadline-exceeded" | "idle-timeout";
export type V2CompactionDiagnostics = {
	phase: typeof V2_PHASES[number];
	attempt: number;
	elapsedMs: number;
	idleMs: number;
	firstByteMs?: number;
	receivedBytes: number;
	eventCount: number;
	lastEvent?: typeof V2_EVENTS[number];
	outputReceived: boolean;
	interruption?: V2Interruption;
};

/** Operation-local observation only: no payload, credentials, URL, response ID or blob. */
export class V2Transport {
	readonly signal: AbortSignal;
	private readonly started = performance.now();
	private lastActivity = this.started;
	private phase: V2CompactionDiagnostics["phase"] = "request";
	private attempt = 0;
	private receivedBytes = 0;
	private eventCount = 0;
	private firstByteMs?: number;
	private lastEvent?: V2CompactionDiagnostics["lastEvent"];
	outputReceived = false;
	private readonly deadline: AbortSignal;
	private readonly idle = new AbortController();
	private idleTimer?: ReturnType<typeof setTimeout>;
	private heartbeat?: ReturnType<typeof setInterval>;

	constructor(private readonly options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		idleTimeoutMs?: number;
		onProgress?: (progress: V2CompactionDiagnostics) => void;
	}) {
		this.deadline = AbortSignal.timeout(options.timeoutMs ?? NATIVE_V2_TIMEOUT_MS);
		this.signal = AbortSignal.any([this.deadline, this.idle.signal, ...(options.signal ? [options.signal] : [])]);
		this.touch();
		if (options.onProgress) {
			this.heartbeat = setInterval(() => this.publish(), 1000);
			this.heartbeat.unref?.();
		}
	}

	interruption(error?: unknown): V2Interruption | undefined {
		// An explicit caller cancellation must never start a fallback, even at the deadline.
		if (this.options.signal?.aborted) return "aborted";
		if (this.idle.signal.aborted) return "idle-timeout";
		if (this.deadline.aborted) return "deadline-exceeded";
		return isAbortError(error) ? "aborted" : undefined;
	}

	snapshot(): V2CompactionDiagnostics {
		const now = performance.now();
		return {
			phase: this.phase, attempt: this.attempt,
			elapsedMs: Math.max(0, Math.floor(now - this.started)),
			idleMs: Math.max(0, Math.floor(now - this.lastActivity)),
			...(this.firstByteMs !== undefined ? { firstByteMs: this.firstByteMs } : {}),
			receivedBytes: this.receivedBytes, eventCount: this.eventCount,
			...(this.lastEvent ? { lastEvent: this.lastEvent } : {}),
			outputReceived: this.outputReceived,
			...(this.interruption() ? { interruption: this.interruption() } : {}),
		};
	}

	publish(): void {
		try { this.options.onProgress?.(this.snapshot()); } catch { /* Observation cannot decide compaction. */ }
	}

	private touch(): void {
		this.lastActivity = performance.now();
		clearTimeout(this.idleTimer);
		if (this.options.idleTimeoutMs && this.options.idleTimeoutMs > 0) {
			this.idleTimer = setTimeout(() => this.idle.abort(new DOMException("Native compaction idle timeout", "TimeoutError")), this.options.idleTimeoutMs);
			this.idleTimer.unref?.();
		}
	}

	begin(attempt: number): void {
		this.attempt = attempt;
		this.phase = "request";
		this.touch();
		this.publish();
	}

	headers(): void { this.phase = "headers"; this.touch(); this.publish(); }
	bytes(length: number): void {
		if (length === 0) return;
		this.firstByteMs ??= Math.max(0, Math.floor(performance.now() - this.started));
		this.receivedBytes += length;
		const changed = this.phase === "headers";
		if (!this.outputReceived) this.phase = "streaming";
		this.touch();
		if (changed) this.publish();
	}
	event(type: unknown): void {
		this.eventCount++;
		this.lastEvent = (V2_EVENTS as readonly unknown[]).includes(type) ? type as V2CompactionDiagnostics["lastEvent"] : "other";
	}
	output(): void {
		if (this.outputReceived) return;
		this.outputReceived = true; this.phase = "compaction-output"; this.publish();
	}
	completed(): void { this.phase = "completed"; this.publish(); }

	/** Do not depend on a fetch/reader implementation acknowledging AbortSignal to settle. */
	wait<T>(operation: () => Promise<T>): Promise<T> {
		if (this.signal.aborted) return Promise.reject(this.signal.reason);
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => { this.signal.removeEventListener("abort", onAbort); reject(this.signal.reason); };
			this.signal.addEventListener("abort", onAbort, { once: true });
			Promise.resolve().then(() => { this.signal.throwIfAborted(); return operation(); }).then(
				value => { this.signal.removeEventListener("abort", onAbort); resolve(value); },
				error => { this.signal.removeEventListener("abort", onAbort); reject(error); },
			);
		});
	}

	dispose(): void {
		clearTimeout(this.idleTimer);
		clearInterval(this.heartbeat);
		this.publish();
	}
}
