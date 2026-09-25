# Spec Delta

## Purpose

Preserve useful conversation history across native and portable compaction while avoiding unnecessary text-model calls for sessions that never leave their native model, and provide predictable, observable fallback and accounting behavior.

## ADDED Requirements

### Requirement: Supported Pi version
The extension SHALL require Pi coding-agent 0.87.1 or newer for its public session-projection and cache-warming hooks rather than silently pretending the on-demand continuity feature works on older runtimes.

#### Scenario: Unsupported older Pi
- **WHEN** the package is installed into a Pi runtime older than 0.87.1
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

### Requirement: Native compaction usage accounting
The extension SHALL include provider-reported native-compaction usage in the Pi compaction result when valid usage is available, using Pi's usage shape and the active model's pricing. It SHALL not fabricate usage when the provider omits it. Usage from an on-demand portable summary SHALL remain explicitly attributable even if the current public extension API cannot add it to Pi's own session totals.

#### Scenario: V2 reports usage
- **WHEN** a native V2 response includes token usage
- **THEN** the persisted compaction entry includes that usage and Pi session totals can count it.

#### Scenario: Provider omits usage
- **WHEN** a native response lacks valid usage
- **THEN** no fabricated token or cost numbers are reported as actual usage.

### Requirement: Retriable transport failures only
Native compact retries SHALL be limited to failures for which replaying the request is safe and useful. Explicit terminal provider failures and user aborts SHALL not be retried as stream-parse errors.

#### Scenario: Server reports terminal failure
- **WHEN** the stream reports a terminal provider failure
- **THEN** the extension does not issue another identical compact request solely because the response was received as SSE.

#### Scenario: Recoverable transport interruption
- **WHEN** a transient transport interruption occurs before successful completion
- **THEN** bounded retry may occur with abort respected; exhaustion proceeds through the configured fallback chain.
