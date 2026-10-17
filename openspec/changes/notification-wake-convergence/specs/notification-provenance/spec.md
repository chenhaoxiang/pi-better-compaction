## ADDED Requirements

### Requirement: Notification source must survive parent wake
A supported native custom turn SHALL preserve its custom source and run before_agent_start without adding a synthetic human message. Older supported hosts SHALL retain the safe compatibility lifecycle. Abort holds and shared reservations SHALL remain effective.

#### Scenario: Native completion wake
- **WHEN** a saved result wakes an idle parent on Pi 1.3+
- **THEN** its custom event starts the normal lifecycle without an extra user prompt

### Requirement: Ordinary peer status must not create new work
The default Intercom policy SHALL persist/display ordinary status without automatically starting a model turn. Explicit asks, replies and non-blocking wake requests SHALL remain actionable, subject to receiver policy.

#### Scenario: Status versus request
- **WHEN** an idle receiver gets an ordinary status followed by an explicit wake request
- **THEN** only the explicit request triggers a model turn and neither message is lost

### Requirement: Machine traffic must not evict human plaintext anchors
Native V2 plaintext retention SHALL use actual active-branch source roles and context edits. Custom notices SHALL still be included in the full compaction request and original history.

#### Scenario: High-volume status traffic
- **WHEN** hundreds of custom status messages follow a real human acceptance criterion
- **THEN** they do not consume its additional plaintext retention budget and the opaque/history data remains unchanged
