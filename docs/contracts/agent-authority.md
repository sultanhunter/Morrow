# Agent authority decisions

Internal engineering contract, canonical64/P05.T04a. This specifies a server-only decision kernel with synthetic fact readers. It does not extend frozen v1 business schemas or qualify an issuer, authenticated agent, persistence adapter, route, scheduler or runtime.

## Origin and delegation

A principal work envelope is a closed internal policy fact, not an existing Task field or a model prompt. It binds the originating human, explicit authorizer, task and envelope revisions, tenant, capabilities, operation verbs, resources, accounts, fields, validity and revocation. The initial implementation requires requester and authorizer to be the same current human; a separately audited authority handoff is later work. Current grants can narrow eligibility after the envelope is created. Later grant expansion cannot enlarge its original bounds.

For a requested operation, the originating human must independently hold a current whole-operation grant for the requested verb and another covering delegation of that capability. A view needs view plus delegate, not execute. Each delegation must narrow its parent's full capability/verb/scope and validity bounds. The specialist needs its own current whole-operation grant and active installation scope. Partial grants cannot be joined to manufacture field or resource coverage at any layer.

Every dispatcher needs workspace.task.delegate with the delegate verb on its own parent task and taskId, installationId and mandate field permissions. Parent-task dispatch authority is distinct from domain tool authority. A built-in coordinator can possess dispatch authority without possessing a refund execution grant or being represented as an installed Chief of Staff. Installed dispatchers and the specialist must bind their real installation/owner/grant records. An installation may belong to another eligible workspace member. Check that owner's current membership and operation grants independently, including parent-task dispatch grants for an installed dispatcher. Shared installations never transfer authority to the requester. Each hop binds its explicit parent-task ResourceRef; do not infer task store scope from the target resource.

Delegation lineage is bounded and acyclic, with exact parent/child actor, task and envelope bindings. Current depth and child counts establish eligibility only. Allowed delegation retains an explicit atomic-delegation-admission obligation; package6 must qualify reservation, persistence and fencing before concurrent dispatch can consume it.

## Installation and automation

Resolve every referenced grant or mandate against its current tenant/store/ID, record revision and canonical content digest. A grant record's reference revision is not Grant.policyRevision, which describes organization policy. Historical snapshots are evidence, not current authority.

Automation uses the existing AutomationMandate and AgentInstallation contracts. Require the same active human owner, current principal and workspace memberships, current owner operation grants, current installed-agent grants, exact installation/mandate binding, mandate capability/scope, start/expiry/revocation, and current resource/account/provider/entitlement facts. The membershipActive fact is used for human membership; agent identities have no human membership ID and instead require current principal/workspace and installation/owner eligibility. Durable owner eligibility does not require an active browser session. Do not convert an agent into a human or fabricate sessionCurrent to reuse a human allow.

Departure, grant revocation, installation disablement, ownership changes or expired mandates deny later eligibility. Approval and budget references confer no permission. Automated approve/administer operations, human-review-only and operator-only capabilities, unqualified services and authority transfers remain denied in this local increment.

## Request and result boundary

Only a trusted current-fact reader supplies authority. Caller inputs are bounded primitive JSON text encoding closed selectors and PermissionRequest; trusted readers similarly return bounded JSON text for authority facts. Object/proxy/accessor inputs are rejected before reflection. The reader receives the validated immutable selector record. JSON parsing produces safe data for closed validation, snapshotting and canonical digests without relying on unsupported Node proxy-inspection APIs. Models and HTTP clients cannot supply actor, grant or allow facts. Snapshot requests before awaits and validate bounded plain JSON before schema, digest or property access. Reload facts for every call. No allow cache exists. A later production reader must prove current SQL ownership and revalidation after asynchronous constraints.

Return canonical PolicyDecision and unfulfilled dispatch, approval, budget and provider-verification obligations. An allowed result may include bounded internal requester/authorizer/dispatcher/executor lineage for later durable recording. Denials expose no lineage or foreign actor identifiers. Reader failures and malformed data produce fixed redacted boundary errors without provider/session content.

A decision does not authenticate, approve, reserve, issue, persist, schedule or execute. Existing human policy and SQL entry points remain unchanged and continue denying agents. Fixture decisions are local kernel evidence only; P05 remains In progress.


Future P06/P12 admission must persist and recheck exact envelope, task, hop, installation, grant and mandate record revisions/content digests from trusted state. The kernel's bounded actor lineage is attribution, not a durable dispatch proof. A trusted reader callback is executable server code; the JSON boundary governs data delivered to the kernel, not arbitrary code inside that callback or native Promise resolution.

## Contract v1.1: executor classes (P01.T02a PR-A)

Every capability declares an `executor` (ADR-0005 §2, ADR-0011 Q7): `human_only`, `agent_after_approval`, `agent_direct_write` or `agent_direct_read`. The kernel's `allowedOperation` adds one condition to the existing ones: on a `human_only` capability, the only verb an agent may hold is `propose`, and only where a proposal path exists, meaning the capability is a kill switch or reviewed. Every other verb gives `capability_denied`, including `view`, so human-only reads are covered. `propose` is denied where no proposal path exists, as for `workspace.task.takeover`. Grants, installation titles and delegation cannot widen this. `agent_after_approval` capabilities keep their `exact_approval` obligation, and `agent_direct_write` and `agent_direct_read` keep the existing behaviour and confer nothing new.

`human_only` covers every `control` capability (grant, membership, connection, installation and release changes, mandate activation, review policy revisions and the approval decision itself), every `eligible_human_*` capability (including `governance.approval.preview` since PR-B), the five kill switches, and `workspace.task.takeover`, `governance.audit.export` and `governance.privacy.export`. An agent may propose `governance.review_policy.revise`, a reviewed access change, but never preview or decide an approval. `workspace.task.delegate` and `workspace.routine.configure` stay `agent_direct_write`, because they dispatch or configure bounded work inside existing grants and envelopes. P11.T05's tenant, installation and platform stops are gateway controls, not capability executions, so `human_only` does not apply to them.

## Contract v1.1: agents and review (P01.T02a PR-B)

An agent's proposal is a Proposal@2 built by the server: the agent is `proposedBy`, and `requestedBy` is the human task initiator or mandate owner, so the requester is conflicted for review like any proposer (ADR-0011 Q1). `contextTaint` records whether the run consumed untrusted external evidence; it is a field only, and the rule that acts on it needs its own ADR before P11.T02 enforces it. Approval@2 reviewers are human members only, and no decision, preview or source proposal confers authority on the executing agent: the gateway rechecks the intersection at dispatch.
