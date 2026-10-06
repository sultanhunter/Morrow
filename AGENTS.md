# Morrow project instructions

## Canonical build plan

The only authority for WHAT and HOW we build is https://chatgpt.com/space/page_b1ef27b80b788191b91e67cbb52f1037 (Page ID page_b1ef27b80b788191b91e67cbb52f1037).

Before every bounded task and after any resumed/compacted session:
1. Read this file, docs/progress/checkpoint.md, the active packet and repository diff.
2. Read the current build plan through the Pages connector. Refresh docs/plan/build-plan.md and docs/plan/source.json from that exact read. Keep the active package, dependencies and acceptance cases in context. Never silently use a stale snapshot. If the Page is unavailable, perform only independent inspection/research and report the gap before dependent implementation.
3. Use the existing 18-package sequence and task IDs. The other three design documents are supporting detail only; resolve conflicts in the build plan first.
4. Improvements affecting scope, architecture, authority, state, providers, billing or gates must be recorded in the build plan Page BEFORE implementing them. Refresh the snapshot and affected packet. Routine choices consistent with the plan do not require a new approval.
5. Materialize one bounded packet with inputs, exact outputs, acceptance cases and executable checks. Do not skip dependencies to build visible screens.

## Settled product constraints

Name: Morrow. Broad production foundation for small and large Shopify brands; no MVP scope reduction. Visual option 1. One complete standalone Morrow workspace plus a thin Shopify read/write connector for install/link/status/reconnect/disconnect/return. No embedded domain workspace in this release. Connector UI/distribution and external billing/revenue treatment remain qualified launch gates. Paid managed model APIs and one work-credit balance; no free merchant tier or separate infrastructure pricing ladder. Coordinator is separate from optional Chief of Staff/CMO installations. Agent titles and delegation never confer authority.

## Implementation discipline

P01 contracts first. P02 interaction baseline before feature UI. P03 creates the application scaffold after qualified P01; the initial P01 bootstrap was documentary tooling; P03 now contains application shells and a synthetic laboratory, without accepted feature UI. TypeScript/React and PostgreSQL are defaults; Canonical sequences 16–22 select Cloudflare public assets, AWS us-east-1/Aurora/Fargate, Temporal Cloud and WorkOS; documentary selection is separate from account, engineering and production qualification.

Do not place secrets, customer records or browser session material in the repo. Provider access and production approvals must be evidenced, never inferred from browser login. Permission and budget checks happen outside model prompts. Verify outcomes and unknown provider effects before retrying. Preserve task, evidence, source revision and decision IDs on resume.

Use pinned Node24.13.0. Run npm run ci and npm run smoke:scaffold for the local engineering baseline; browser prototype checks remain separately recorded. Checks and self-review do not confer real tenant/provider access or satisfy P02 participant/remote protected-review gates.

Persist status and next action in docs/progress/checkpoint.md. Report self-review separately from independent review and launch qualification. Do not mark a task Verified merely because structural checks pass.

Canonical sequence29: GitHub plan eligibility does not block coding. P03engineering qualifies subsequent local infrastructure definitions/labs. Actual host-enforced protection gates release-code merges and privileged deployment; no paid subscription or public visibility change to continue. Preserve provider/paid-provisioning and P02feature qualification gates.

Canonical sequence35: reviewed P04 engineering plus actual isolated PostgreSQL17 rotation/recovery primitives qualifies P05 local identity/membership/policy code and real local SQL tests. Actual P04/provider evidence still gates hosted identity/SSO/SCIM/session qualification and activation. No local identity adapter can authenticate production requests. Keep real entry routes denied until a selected-provider boundary is qualified.
