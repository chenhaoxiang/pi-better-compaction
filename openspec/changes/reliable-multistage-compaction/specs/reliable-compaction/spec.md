# Spec Delta

## Purpose

Preserve useful conversation history across native and portable compaction while avoiding unnecessary text-model calls for sessions that never leave their native model, and provide predictable, observable fallback and accounting behavior.

## ADDED Requirements

### Requirement: Supported Pi version
The extension SHALL require Pi coding-agent 1.3.0-fork.1 or newer for the maintained SDK baseline, public session-projection and cache-warming hooks, and current cross-model reasoning semantics rather than silently pretending the on-demand continuity feature works on older runtimes.

#### Scenario: Unsupported older Pi
- **WHEN** the package is installed into a Pi runtime older than 1.3.0-fork.1
- **THEN** its published peer-dependency and documentation requirements identify that runtime as unsupported.

### Requirement: Native-first ordered compression
For a supported Responses API, the extension SHALL try the configured native protocol first. On a non-abort native failure it SHALL try the configured primary text-compaction model, each additional configured text model in order, and then Pi's default compaction. A successful strategy SHALL stop the chain. A user abort SHALL cancel rather than start another strategy.

#### Scenario: Native succeeds
- **WHEN** a native compact request succeeds on a supported Responses model
- **THEN** the extension stores a replayable native checkpoint without calling a text summarizer solely for future model switches.

#### Scenario: Ordered failure chain
- **WHEN** native compact and the first text model fail without aborting and a later configured model succeeds
- **THEN** the later model's portable result is used, and no later model or Pi-default compaction is invoked.

#### Scenario: All configured strategies fail before a native checkpoint exists
- **WHEN** native and all configured text models fail without aborting and the session has no prior opaque checkpoint
- **THEN** Pi's built-in compaction is offered the still-complete pre-compaction history; the extension SHALL NOT store a false-success checkpoint.

#### Scenario: Native failure after an opaque checkpoint
- **WHEN** native compaction fails and the latest prior summary is only an opaque-checkpoint marker
- **THEN** the extension rebuilds the entire pending hidden history from the raw active branch and tries the configured portable summarizers followed by the active model. If all fail it cancels compaction rather than asking Pi to summarize a marker.

### Requirement: Portable continuity on first incompatible request
When the latest session checkpoint is native and the selected model cannot replay it, the extension SHALL generate a portable summary only when the new model is about to make its first actual request. It SHALL derive the summary from the active branch's projected pre-compaction history, including all native-compacted spans and context edits, and persist it without replacing the native checkpoint. It SHALL NOT send a placeholder as if it were the summarized history.

#### Scenario: Switch and switch back without a request
- **WHEN** a user selects an incompatible model and switches back before sending any message
- **THEN** no portable summarization call occurs and the native checkpoint remains usable.

#### Scenario: First incompatible request after repeated native compaction
- **WHEN** the first request follows two or more native compactions, possibly across reload or a fork
- **THEN** a bounded, complete portable summary of the active branch is generated, reused for that request, and cached for compatible later requests.

#### Scenario: Switch back to original native model
- **WHEN** a portable summary has already been created and the user later requests the original native model
- **THEN** the native checkpoint is still available for replay and the portable summary does not replace it.

#### Scenario: Portable summarization cannot complete safely
- **WHEN** all configured summarizers and the safe Pi-default summarizer fail or the active branch cannot be reconstructed
- **THEN** the first incompatible request is visibly aborted without sending an opaque-only placeholder; the raw session and native checkpoint remain recoverable.

#### Scenario: Cache warming while portable summary is absent
- **WHEN** cache warming would send a request to an incompatible model before portable continuity is prepared
- **THEN** the extension stops that warming request rather than sending the placeholder.

### Requirement: Native replay failure is not silent
When the current request is expected to replay a native checkpoint but its environment or payload cannot be safely rewritten, the extension SHALL NOT send Pi's opaque-only placeholder as if it were conversation history.

#### Scenario: Same-model replay mismatch
- **WHEN** a native-model provider request cannot be aligned with the persisted checkpoint
- **THEN** that request is visibly aborted and the checkpoint remains intact for later recovery.

#### Scenario: Extension disabled after an opaque checkpoint
- **WHEN** the extension is disabled while an opaque-only checkpoint remains in the active session
- **THEN** it stops new compaction but still aborts a request that would send the placeholder as history.

### Requirement: Verified resumable portable prefixes
Completed portable chunks MAY cache bounded context-invisible native-branch progress. Reuse SHALL require exact checkpoint, candidate identity and input/output digests. Remaining history SHALL be complete before business context uses it. Raw history, native checkpoint and retained tail SHALL remain unchanged. No retry worker or second history store is introduced.

#### Scenario: Cancel and resume without repeated completed calls
- **WHEN** one chunk completed and cancellation stops the next work
- **THEN** the failed attempt does not return partial success, and a later matching attempt may start with the verified prefix and only generate remaining chunks, including after native-entry persistence and runtime reopening. Older uncheckpointed partial work remains unavailable.

#### Scenario: SDK returns partial text on abort
- **WHEN** the SDK returns nonempty partial text with an aborted/incomplete final response or the caller cancels before the chunk can be committed
- **THEN** returned usage is preserved but no progress or complete event is committed for that chunk. Only prior successful prefixes remain reusable, the unfinished chunk is processed again on an authorized normal attempt, and cancellation never starts a backup candidate.

#### Scenario: Changed or corrupted progress
- **WHEN** identity, endpoint, instructions, thinking, prefix input, chunking policy or output digest differs, or cache coverage is unavailable
- **THEN** that prefix is not reused; missing evidence never becomes a completed summary. A partial cache alone does not permit cache warming with an opaque-only history.

#### Scenario: Responsive planning and bounded input
- **WHEN** a long source is prepared or cancelled
- **THEN** message sizing is linear with event-loop yields and exact serialized chunk rechecks, large-model payloads remain inside the existing safe half-window and accumulated-summary bounds, and caller cancellation stops the chain without changing model/thinking/fallback order or claiming upstream rollback.

#### Scenario: Actual usage across recovery
- **WHEN** a portable attempt fails or a later attempt reuses completed prefixes
- **THEN** reported usage contains only calls made in that invocation; failed manual work also retains its reported usage separately, while missing or ambiguous billing remains unknown.

### Requirement: Native compaction usage accounting
The extension SHALL include provider-reported native-compaction usage in the Pi compaction result when valid usage is available, using Pi's usage shape and the active model's pricing. It SHALL not fabricate usage when the provider omits it. Usage from an on-demand portable summary SHALL remain explicitly attributable even if the current public extension API cannot add it to Pi's own session totals.

#### Scenario: V2 reports usage
- **WHEN** a native V2 response includes token usage
- **THEN** the persisted compaction entry includes that usage and Pi session totals can count it.

#### Scenario: Provider omits usage
- **WHEN** a native response lacks valid usage
- **THEN** no fabricated token or cost numbers are reported as actual usage.

### Requirement: Local model-ID priorities and visible compaction method
A nonempty `localCompactionModels` list SHALL replace explicit-provider text candidates without changing native-first behavior. Exact registered model IDs under provider names containing `local` SHALL run at their declared thinking levels in model-ID order and stable provider-name order. Missing/auth-failed models SHALL be skipped without probes or unlisted external candidates; non-abort failure advances the chain. Provider names do not establish trust.

#### Scenario: Native success with local priority configured
- **WHEN** a supported Responses native compaction succeeds
- **THEN** no local text candidate runs and the native checkpoint is retained.

#### Scenario: Models are missing, unauthenticated, or fail
- **WHEN** native compaction fails and the first exact-ID candidate is unauthenticated, the next is not registered under a `local`-named provider, and a later candidate succeeds
- **THEN** only registered, authenticated candidates receive real compaction requests in model-ID order at their declared thinking levels, with no separate network probe; success stops the chain. Before any opaque checkpoint, exhaustion SHALL offer Pi's default text compaction; after a checkpoint, portable recovery SHALL end with the active model and abort on total failure.

#### Scenario: No candidate safely summarizes an opaque checkpoint
- **WHEN** an already opaque-compacted session needs portable history and all configured candidates plus the active model fail
- **THEN** the request is aborted before its placeholder reaches the provider.

#### Scenario: Visible method without false completion
- **WHEN** an interactive or RPC UI is available during native, text, or portable compaction
- **THEN** its status shows the attempted method and model and a successful path identifies the method; Pi-default completion is reported only after Pi emits its success event. Non-UI modes continue without display errors.

### Requirement: Retriable transport failures only
Native compact retries SHALL be limited to failures for which replaying the request is safe and useful. Explicit terminal provider failures and user aborts SHALL not be retried as stream-parse errors.

#### Scenario: Server reports terminal failure
- **WHEN** the stream reports a terminal provider failure
- **THEN** the extension does not issue another identical compact request solely because the response was received as SSE.

#### Scenario: Recoverable pre-output transport interruption
- **WHEN** a transient transport interruption occurs before any compaction output and before successful completion
- **THEN** bounded retry may occur with abort respected; exhaustion proceeds through the configured fallback chain.

#### Scenario: Ambiguous interruption after compaction output
- **WHEN** an output item has already arrived but the stream ends or throws before `response.completed`
- **THEN** the extension neither persists the partial blob nor issues an automatic second native request; it proceeds through the configured fallback chain.

### Requirement: Native V2 waiting is bounded and distinguishable from user cancellation
The existing native V2 deadline SHALL span the complete native operation including retries. Deadline and optional inactivity expiry SHALL be classified separately from explicit caller cancellation and SHALL enter the safe existing fallback chain. Explicit caller cancellation SHALL stop that chain. The extension SHALL settle locally even when the transport does not acknowledge cancellation, without asserting that upstream work/billing was rolled back.

#### Scenario: Silent transport expires
- **WHEN** native headers or a body read remains pending until the native deadline or configured idle limit
- **THEN** the operation returns a closed deadline/idle reason, does not renew the total deadline or issue another native POST, and offers the existing complete-history fallback.

#### Scenario: Output is announced before interruption
- **WHEN** native output has been announced or received but successful completion is missing
- **THEN** no partial native checkpoint is saved and no second native request is sent. `[DONE]` or `response.incomplete` terminates the read rather than waiting for connection EOF.

#### Scenario: Native transport diagnostics survive reload without leaking history
- **WHEN** automatic or manual native compaction is pending or returns
- **THEN** stage and timing/count metadata is visible; returned native operations append only context-invisible closed-label metadata, and status may restore at most twelve observations from the active branch without calls, authentication, raw payloads or billing claims.

### Requirement: Anthropic native blocks preserve portable history
The extension SHALL support owner-approved Anthropic on-demand compaction without weakening any existing opaque checkpoint safety boundary. A successful signed block SHALL carry real readable summary text; only the same provider, API, model and base URL may replay the signature.

#### Scenario: Native Anthropic success and identity change
- **WHEN** Anthropic returns a valid signed compaction block and a later request changes identity
- **THEN** the persisted readable summary remains available and the signature is not sent to the other identity.

#### Scenario: Prior OpenAI opaque history
- **WHEN** an Anthropic compaction or request follows an unresolved OpenAI opaque checkpoint
- **THEN** the complete pending raw history is reconstructed for portability or the operation visibly aborts; the marker is never treated as a real summary.

#### Scenario: Block rejected or usage absent
- **WHEN** a replayed block is rejected with HTTP 400 or compaction usage is absent/invalid
- **THEN** the signature is retired without deleting the readable summary, and no token/cost values are fabricated.

### Requirement: Read-only checkpoint and usage visibility
The extension SHALL expose a read-only command using only the active branch and bounded in-process attempt metadata. It SHALL separate Pi-counted compaction usage from later portable-summary observations, preserve missing counts/cost as unknown and SHALL NOT generate summaries, resolve authentication, issue model requests or certify endpoint/switch safety.

#### Scenario: Inspect an opaque checkpoint
- **WHEN** a user inspects status after compaction or reload
- **THEN** checkpoint and digest-matching portable-cache state are shown without raw summaries/blobs/URLs, and absent runtime attempts are explicitly unknown.

#### Scenario: Usage includes unsuccessful portable work
- **WHEN** branch custom entries retain reported usage from a failed portable attempt
- **THEN** those observations remain visible separately from Pi-counted compaction entries; missing or malformed observations never become fabricated zero bills.
