# Runtime provider portability blueprint

Implementation guidance for canonical59/P04.T01h, the prior54/P04.T01g blueprint and future P12. Morrow owns the agent harness and business state. An execution provider supplies an isolated computer through a server-side adapter. The production runtime and adapter registry have not been implemented; the current E2B implementation is a separate provider-neutral synthetic lab with a dedicated SDK adapter. Legacy Daytona allocation is disabled; original-operation cleanup remains.

## Ownership and module boundaries

| Morrow owns | Provider adapter owns |
| --- | --- |
| Identity, current grants, leases and generation fencing | Translating approved allocation and lifecycle requests |
| Budgets, admissions, billing/work-credit ledger | Provider usage observations with explicit completeness |
| Agent definitions, skills, tool gateway and task tree | Bounded command/file transport and normalized failures |
| Authoritative Neon checkpoints and R2 artifact manifests | Internal provider resource/snapshot handles |
| Reviewed runtime recipes and capability requirements | SDK/API version, native image and lifecycle mapping |

Future packages/runtime/src contains harness/ports with no vendor SDK or direct adapter import. Matching provider modules live under packages/runtime-adapters/src/{provider}/. The designated private Workers composition module selects a qualified adapter and passes its port to the harness; SDK imports remain inside the matching adapter. Current import guards enforce these structural boundaries for reviewed SDK families. SDK aliases/new vendors need explicit boundary review. These checks do not establish actual private service deployment, provider access or safety of arbitrary code.

Do not expose a raw SDK, credential, provider snapshot URL or arbitrary client options to an agent. Adapters cannot grant authority or promote artifacts. Provider-specific limits belong to immutable profile/recipe bindings rather than agent definitions.

## Port and qualification requirements

Future RuntimeProviderPort must describe allocate, inspect/reconcile, bounded execute/read/write, quiesce, restore, delete/verify and usage observation. Model stopped-with-files and paused-with-memory as distinct capabilities. Missing/unknown features fail a profile's requirements; do not emulate strict egress or memory resume with weaker behavior. A provider response alone does not qualify a capability.

Pin provider/account/environment/region, adapter/API/SDK versions, immutable image digest, required/effective capability evidence, operation UUID, original deadline and lease generation before effects. Treat resource IDs as provider-scoped opaque identifiers, with bounded validation inside that adapter; UUID-shaped Daytona IDs must not become a global requirement. Keep native snapshot handles private and bound to the originating profile/provider.

Normalize running/quiesced/terminal observations without flattening uncertainty: pending, not_found, unknown_effect, quota_exhausted and deletion_verified are distinct outcomes. Never retry uncertain allocation under a new operation or select another provider. Reconcile the original name/metadata/resource identity and keep unresolved journals until the outcome is proved. A lookup that resumes or extends runtime must not masquerade as read-only inspect.

Qualify each adapter against actual isolation class, outbound/metadata/private-network denial and exception policy; file/memory lifecycle; quota/funding/retention and maximum lifetime; access/credential scope; cancellation; usage rounding/completeness; and terminal cleanup. Exact source/config/account/version evidence is invalidated by relevant changes. Keep credential brokering and effect authorization outside guests.

## Provider changes and persistence

New allocations may choose another qualified provider through reviewed configuration. In-flight runs keep their original adapter/account/image binding until reconciliation and cleanup finish. Native VM snapshots, RAM/process state and browser sessions are not cross-provider migration formats.

For an explicit migration, freeze/revoke the old writer, reconcile outstanding external effects, export approved files and a digest/revision/scope-bound checkpoint manifest through R2/Neon, validate the new image/recipe, then restore under a new generation and verify results. Keep the old resource pinned until deletion is verified. Unknown connector effects cannot be replayed during migration. R2/Neon preserve Morrow's durable workspace independently of provider disk retention.

## Alternatives researched on 14 October 2026

| Candidate | Testing and commercial fit | Lifecycle considerations |
| --- | --- | --- |
| E2B | Hobby advertises $100 one-time credits/no card, one-hour continuous sessions and 20 concurrent sandboxes. Pro $150/month plus usage is a separate production cost. | Files/memory pause; no automatic expiry of paused instances. Explicit kill, deadline and snapshot tracking required. |
| Modal VM | Starter $0 subscription plus usage/$30 monthly compute credit; payment method required. Explicit VM selection; GA announced 1 October 2026. | File snapshots differ from Alpha memory snapshots. Validate exact runtime capabilities and usage caps. |
| Cloudflare Linux sandbox | Runs an attached Container in its own VM. Hosted Containers require Workers Paid plus metered resources. | File persistence and whole-disk snapshots do not imply process/memory continuity; qualify hosted lifecycle. |

The recommended next no-card lab is E2B; Modal is a candidate to benchmark for production economics. The owner selected E2B on14October2026; selection is not actual project/access or production qualification. Modal and Cloudflare runtimes remain research candidates. E2B's pricing/docs disagree about default RAM, so use actual resource inspection in the test quote rather than assume a shape. No per-run price is accepted until the native image/resources/rates are bound.

Sources: [E2B pricing](https://e2b.dev/pricing), [persistence](https://docs.e2b.dev/sandbox/persistence), [network controls](https://docs.e2b.dev/network/internet-access); [Modal pricing](https://modal.com/pricing), [billing](https://modal.com/docs/guide/billing), [VM launch](https://modal.com/blog/vm-sandboxes-agent-computers), [network controls](https://modal.com/docs/guide/sandbox-networking), [snapshots](https://modal.com/docs/guide/sandbox-snapshots); [Cloudflare VM sandbox](https://developers.cloudflare.com/agents/tools/sandbox/), [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).

## Conformance and next laboratory

Each adapter runs the same behavioral cases with its own provider-specific fixture/configuration: ownership/foreign-ID denial; timeout after allocation with no duplicate; inspect without implicit resume; effective egress at application level; file persistence and separately qualified memory continuity; original deadline across restore; cancellation/revocation/fencing; quota/credit loss; unresolved deletion and retained billing; cleanup-only recovery after funding loss; source/config drift; no credentials/raw errors in evidence. Controlled mocks are local engineering evidence; actual provider cases remain separate.

For E2B, prepare one built-in synthetic marker run, ten-minute outer deadline, native timeout-to-kill, no auto-resume/public traffic, outbound disabled, bounded actual resources/cost and original-operation cleanup. Confirm an owned Morrow account/trial and separately approved private access first. Test creation/reconciliation, marker write/read, explicit pause/resume, application-level network denial and verified kill of the original sandbox plus any snapshot. A paused instance has no automatic expiry, so its own cleanup mechanism must be qualified before use. No new provider effects are authorized by this blueprint.

Live E2B adapter transport under canonical57 uses documented native requests with redirects denied for API and envd credentials. SDK versions/wire types remain pinned as references, while adapter transport security is independently qualified; a typed SDK404 after a redirect is not absence.
