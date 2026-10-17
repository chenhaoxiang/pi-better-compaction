# Design

Keep transport/lifecycle, task authority and history retention separate. A custom notification can carry new evidence and wake an existing authorized task without becoming a new human instruction. No natural-language prefix or model output is used to classify the source.

Pi 1.3 repaired the custom before_agent_start lifecycle; use it directly after conservative stable-version detection, retaining old-host user-wake behavior because supported old hosts otherwise lose hook-set context. Shared manager reservations, abort holds, result ownership, terminal workflow notifications and pending supervisor requests remain intact.

Intercom keeps its existing always/replies/never policy surface. Default replies includes explicit asks and wake:true requests; wake:false suppresses status-only events. Handover sends an explicit wake rather than creating a fake pending ask. Ordinary notices remain visible and persisted without starting another turn.

Compaction still sends the entire request to the native summarizer. Only after success, raw active-branch projection (including context edits) selects actual user/system anchors for the existing bounded retained-message budget. Custom messages remain represented in the encrypted blob and original history. Existing opaque checkpoints are not rewritten.

Validation must cover quoted human text, high-volume machine traffic, opaque preservation, native/legacy wake routes, ask/reply routing, explicit wake/no-wake and human-priority/abort behavior. On-disk installation is versioned and reversible; active sessions/broker are not forcibly reloaded.
