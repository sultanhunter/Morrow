# Routine scheduling

Version: 1.0.0 candidate. Owner: Morrow platform owner. Review: Codex semantic self-review plus schema/fixture checks; integration qualification remains required. Canonical plan sequence: 13. Consumer: P12.

## Shape and ownership

Schemas: Schedule, AutomationMandate. Exact field types, nullability, required properties and closed object validation are in schemas/v1/core.schema.json; capability bodies are in capabilities.schema.json. State actors and guards are in state-transitions.json. Representative valid/invalid fixtures are in fixtures/P01.A02.json. Payload references are immutable scope/revision/digest bindings, not storage URLs or bearer credentials.

## Command and query semantics

Schedules preserve IANA timezone and define daylight-saving behavior, overlap policy, missed-run policy, maximum parallelism and bounded catchup. Activation requires current mandate. Default disabled until configuration. An active routine can emit work only inside its explicit stores/account scope and cannot manufacture approval. Deactivation stops new dispatch and reconciles active jobs.

## Schedule@1 and the shop's zone (ADR-0043 items 7 to 9; plan row SD12)

`Schedule` in schemas/v1.1/core.schema.json is Schedule@1 and replaces v1's cron `Schedule` (changes.json), which nothing stored: kinds `daily` (one to four local times, ascending, at least 15 minutes apart also across midnight), `weekly` (days in week order and one time), `monthly` (day 1 to 28 or `last` and one time) and `every` (15, 30 or 60 minutes, or 2, 3, 4, 6 or 12 hours, as local times from midnight); every time on a 5-minute mark; the schedule's own IANA zone from the closed list (packages/contracts/src/time-zones.ts); `missedRun` `skip` or `run_latest_once`; optional first and last local dates. Code checks what the schema cannot (packages/work/src/schedules/schedule.ts; SQL twin `morrow_work.schedule_body_valid`). `once` is not a kind until plan row SD2's dated note on ADR-0041 items 7 and 20, and standing requests (ADR-0040 item 12) take Schedule@1 only after SD2's dated note on that item.

The database decides when a schedule fires (migration schedules-shop-zone): a local time that does not exist fires at the next valid minute, a repeated one once at its first occurrence, and local times that land on one instant fire once. After downtime `skip` fires the latest due slot only inside its 5-minute on-time window and `run_latest_once` fires it once inside the 24-hour replay horizon; every other due slot is dropped and the next slot moves past now. Each fired slot is one MandateTrigger@1 row keyed `sched:<schedule id>:<slot UTC>`, unique per tenant, written by `fire_due_schedules` from the orchestrator's cron behind the committed-off `schedules-v2` switch.

The shop's zone is Shopify's `ianaTimezone` (read by the broker at the install, a reconnect and the daily health read) unless the Owner overrides it. A change of the effective zone moves no schedule: it raises one Inbox item for the Owner and each listed schedule's owner, and each schedule moves only on a person's tap (`schedule_zone_move`), at the revision they saw.

## Goal records (ADR-0033 item 8; PR 18)

A routine or recurring task names its goal record (`workspace.routine.configure`'s `goalId`), and an alert also the goal's `key` (`goalKey`), so repeating work lives in its project, area or Quick tasks. Moving one is a person's act. A configure revision of an active routine leaves it `disabled` and never activates it; only `workspace.routine.activate` (`human_only`, ADR-0011 Q9's access-change gate) turns one on. A plan start creates an agent's repeating task as a routine configured disabled (ADR-0034 item 5(c)).

## Failure invariant

A schedule burst does not create unbounded child tasks or duplicate a missed occurrence. Failures use ErrorEnvelope and must not leak inaccessible content. Current policy and resource checks apply to all reads, mutations and derived artifacts.

## Compatibility and evidence

Every command/read declares schema version 1. Unknown fields and invalid enum values fail validation; no implicit coercion/default authority. Breaking fields/states/meaning require a new version and explicit migration with retained workflow histories. Additions remain opt-in via negotiated schema versions, not silently accepted fields. Consumers pin reviewed contract revisions. Run npm run verify:contracts and npm run test:contracts for contract fixture evidence; these do not prove production authorization or provider access. Open provider/region/retention/billing targets remain in the decision register and block consumers that need them.
