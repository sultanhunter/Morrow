# Capability and authority catalogue

P01.T01 candidate, version 0.1.0-draft. The canonical build plan controls this implementation record. Every capability remains Proposed and blocked from activation. Typed references and lists below are proposed shapes; P01.T02 resolves their nested schemas, validation and retention durations. P01.T03 qualifies exact provider APIs/scopes and access.

## Common request and result envelopes

ScopedRequestV1: schemaVersion (integer); commandId (opaque ID); trusted principal reference; organization/workspace identity resolved server-side; explicit store/account/resource/field scope; expected aggregate revision for writes; immutable proposal and approval references when required; correlation ID. Browser host flags or shop URLs never establish tenant authority.

EvidenceResultV1: status (closed enum to be specified in P01.T02); operation/run/record ID as appropriate; evidence references with provider identity, observation time, source revision, coverage and lineage; safe structured failure. Error categories: denied, missing input, conflict, unavailable, rate limited, rejected, uncertain, budget exhausted. Never expose inaccessible records in denials. External submission is not completion: reconcile the declared postcondition.

Each field listed is required and non-null in this proposed shape. Optionality and bounded array limits are resolved explicitly in P01.T02 rather than assumed in code. Source authority: provider facts for live state, eligible human-approved evidence for claims, Morrow for work and decisions. No generated text becomes authoritative merely because it is recent.

## Workspace coordination

### workspace.goal.create

Create a scoped business goal. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: objective: string; storeIds: IdList; successCriteria: CriteriaList. Output: goalId: Id; revision: Revision.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.goal.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: objective, scope, successCriteria. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Goal has one accountable owner and explicit store scope. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.task.create

Create work under a goal. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: goalId: Id; objective: string; allowedResources: ResourceList. Output: taskId: Id; revision: Revision.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.task.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: objective, scope, dependencies. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Task scope is a subset of the goal and initiating grant. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.task.assign

Assign an eligible human or installation. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: taskId: Id; assigneeId: Id; expectedRevision: Revision. Output: assignmentId: Id; revision: Revision.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.task.assign. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: assignee. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Assignment changes responsibility without changing grants. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.task.delegate

Delegate bounded work to a specialist. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: taskId: Id; installationId: Id; mandate: MandateRef. Output: childTaskId: Id; scope: ScopeRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.task.delegate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: delegated resources, capabilities, budget, expiry. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Child authority cannot exceed the originating task envelope. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.task.takeover

Claim task ownership from an agent. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: taskId: Id; expectedRevision: Revision. Output: leaseId: Id; generation: Revision.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.task.takeover. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: execution owner, lease. Executor: human_only. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: A stale executor cannot continue writing after takeover. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.task.pause

Pause new dispatch for a task. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: taskId: Id; expectedRevision: Revision. Output: status: TaskStatus; pendingOperations: IdList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.task.pause. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: dispatch state. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Submitted provider jobs remain visible and reconciled. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.task.resume

Resume eligible paused work. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: taskId: Id; expectedRevision: Revision. Output: status: TaskStatus; runId: Id.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.task.resume. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: dispatch state. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Current grants and budgets are rechecked before dispatch. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.task.cancel

Cancel work and reconcile liabilities. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: taskId: Id; expectedRevision: Revision. Output: status: TaskStatus; liabilities: LiabilityList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.task.cancel. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: dispatch state. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Cancellation does not assert reversal of submitted effects. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.question.request

Ask a typed question of an eligible person. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: taskId: Id; question: string; answerSchema: SchemaRef; respondentId: Id. Output: questionId: Id; status: QuestionStatus.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.question.request. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: question, respondent, answer schema. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Missing input is represented as a durable question. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.question.answer

Answer an assigned question. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: questionId: Id; answer: AnswerRef; expectedRevision: Revision. Output: answerRevision: Revision.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.question.answer. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: answer. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Answer schema and eligible respondent match the request. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.artifact.read

Read an authorized artifact revision. Owner: Morrow platform owner. Effect: read. Provider: morrow (D01, Design recorded).

Input: artifactId: Id; revision: Revision. Output: contentRef: ArtifactRef; lineage: EvidenceList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.artifact.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: authorized content fields. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Derived source restrictions apply to the artifact. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.artifact.edit

Edit a draft with revision checks. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: artifactId: Id; expectedRevision: Revision; patch: PatchRef. Output: revision: Revision; diffRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.artifact.edit. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: draft content. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Conflicting edits produce a conflict rather than silent overwrite. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.comment.create

Comment on an accessible artifact anchor. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: artifactId: Id; revision: Revision; anchor: AnchorRef; body: string. Output: commentId: Id.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.comment.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: comment body, anchor. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Anchor resolves to the specified artifact revision. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.knowledge.approve

Approve a sourced business fact or policy. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: recordId: Id; expectedRevision: Revision; sourceRefs: EvidenceList. Output: approvedRevision: Revision.

Authority: eligible_human_reviewer_with_explicit_decision_grant; explicit grant workspace.knowledge.approve. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: claims, policies, source references. Executor: human_only. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Approver has knowledge authority and conflicting sources are explicit. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.knowledge.read

Retrieve approved permission-filtered knowledge. Owner: Morrow platform owner. Effect: read. Provider: morrow (D01, Design recorded).

Input: query: string; resourceScope: ScopeRef. Output: records: KnowledgeList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.knowledge.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: approved knowledge fields. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: No inaccessible record or derived fact leaks through retrieval. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.routine.configure

Configure a disabled schedule and bounded mandate. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: installationId: Id; schedule: ScheduleRef; mandate: MandateRef. Output: routineId: Id; revision: Revision.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.routine.configure. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: trigger, timezone, overlap policy, mandate. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Configuration does not activate background authority. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### workspace.routine.activate

Activate an explicitly granted routine. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: routineId: Id; expectedRevision: Revision; mandate: MandateRef. Output: activationId: Id; status: RoutineStatus.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant workspace.routine.activate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: active schedule. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Expiry and revocation constrain every future execution. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J01; P14.T01, P17.T01; P01.A01, P14.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Catalog

### catalog.products.read

Read selected products and variants. Owner: Morrow platform owner. Effect: read. Provider: shopify (D02, Design recorded).

Input: productIds: IdList; fields: FieldList. Output: products: ProductList; freshness: FreshnessRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.products.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: title, description, SEO, variants, media, tags. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: Results include provider identity and observation time. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### catalog.audit.create

Audit catalog completeness and factual conflicts. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: productIds: IdList; sourceRefs: EvidenceList. Output: auditRef: ArtifactRef; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.audit.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: catalog facts, approved claims. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Every finding cites authorized facts and missing coverage. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### catalog.content.propose

Draft product copy and SEO fields. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: productIds: IdList; claimEvidence: EvidenceList; locale: string. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.content.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: title, description, SEO title, SEO description. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Draft claims match merchant evidence and exact allowed fields. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### catalog.content.publish

Apply an approved product content change. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.content.publish. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: title, description, SEO title, SEO description. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Readback matches selected fields without altering variants or price. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### catalog.variants.propose

Draft variant price and option changes. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: variantIds: IdList; prices: MoneyList; options: OptionList. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.variants.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: price, compare-at price, option values. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Currency and variant identifiers are explicit. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### catalog.variants.publish

Apply approved variant field changes. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.variants.publish. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: price, compare-at price, option values. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Variant readback matches approved values and currency. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### catalog.collection.propose

Draft a collection assortment or ordering. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: collectionId: Id; productIds: IdList; ordering: IdList. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.collection.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: membership, sort order. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Proposal includes prior collection revision and exact product set. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### catalog.collection.publish

Apply an approved assortment change. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.collection.publish. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: membership, sort order. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Collection readback matches approved membership and ordering. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### catalog.channel.publish

Publish approved products to named channels. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef; publicationIds: IdList. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant catalog.channel.publish. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: publication membership. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Only explicitly approved channel publications change. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J02; P09.T02, P17.T01; P01.A01, P17.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Search and discovery

### search.public.inspect

Inspect public pages for discovery evidence. Owner: Morrow platform owner. Effect: read. Provider: public_web (D03, Design recorded).

Input: urls: UrlList; markets: StringList. Output: observations: EvidenceList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant search.public.inspect. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: public page text, metadata, crawl signals. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: Public-only retrieval excludes private sessions and internal addresses. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J03; P17.T03, P17.T01; P01.A01, P17.A03. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### search.performance.read

Read authorized search performance. Owner: Morrow platform owner. Effect: read. Provider: google_search (D04, Design recorded).

Input: propertyId: Id; startDate: Date; endDate: Date; dimensions: StringList. Output: rows: SearchMetricList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant search.performance.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: clicks, impressions, CTR, position. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: Property and reporting basis are explicit; sampled coverage remains visible. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J03; P17.T03, P17.T01; P01.A01, P17.A03. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### search.audit.create

Prepare an SEO and AI discovery audit. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: pageEvidence: EvidenceList; productEvidence: EvidenceList; guidance: EvidenceList. Output: auditRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant search.audit.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: public observations, authorized facts. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Requirements and hypotheses are separated; no citation guarantee. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J03; P17.T03, P17.T01; P01.A01, P17.A03. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### search.improvements.propose

Draft evidence-backed discovery improvements. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: auditRef: ArtifactRef; claimEvidence: EvidenceList. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant search.improvements.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: product SEO, copy, content structure. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Each proposed field maps to an authorized publication capability. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J03; P17.T03, P17.T01; P01.A01, P17.A03. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### search.citations.observe

Record bounded AI answer observations. Owner: Morrow platform owner. Effect: read. Provider: ai_observation (D05, Design recorded).

Input: querySet: QuerySetRef; surfaces: StringList; markets: StringList. Output: observations: EvidenceList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant search.citations.observe. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: public query, answer, citation, observation metadata. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: An observed answer is not a population-level visibility measure. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J03; P17.T03, P17.T01; P01.A01, P17.A03. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### search.results.report

Report publication separately from discovery outcomes. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: publicationReceipts: EvidenceList; observations: EvidenceList. Output: reportRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant search.results.report. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: readback, observed indexing, referrals. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Applied change is separate from later indexing or revenue attribution. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J03; P17.T03, P17.T01; P01.A01, P17.A03. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Creative

### creative.brief.create

Create a sourced product image brief. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: productIds: IdList; inputAssets: ArtifactList; brandEvidence: EvidenceList. Output: briefRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant creative.brief.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: product fidelity constraints, style, outputs. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Brief identifies immutable product features and prohibited changes. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J04; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### creative.image.generate

Submit a bounded image generation job. Owner: Morrow platform owner. Effect: billable_job. Provider: image_model (D06, Design recorded).

Input: briefRef: ArtifactRef; inputAssets: ArtifactList; jobLimits: BudgetRef. Output: operationId: Id; jobId: Id; costReservation: Id.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant creative.image.generate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: authorized input assets, generation parameters. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Job provenance and reserved cost survive submission and retries. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J04; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### creative.contact_sheet.create

Assemble generated assets for review. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: assetRefs: ArtifactList; briefRef: ArtifactRef. Output: contactSheetRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant creative.contact_sheet.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: asset thumbnails, job provenance. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Every image retains source inputs and generation lineage. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J04; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### creative.image.revise

Generate a bounded revision of a selected image. Owner: Morrow platform owner. Effect: billable_job. Provider: image_model (D06, Design recorded).

Input: assetRef: ArtifactRef; briefRef: ArtifactRef; changes: string; jobLimits: BudgetRef. Output: operationId: Id; jobId: Id.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant creative.image.revise. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: selected image, authorized changes. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Product fidelity remains measurable against the source image. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J04; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### creative.image.approve

Record fidelity review of a specific asset revision. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: assetRef: ArtifactRef; review: ReviewRef. Output: approvedAssetRef: ArtifactRef.

Authority: eligible_human_reviewer_with_explicit_decision_grant; explicit grant creative.image.approve. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: review result, selected revision. Executor: human_only. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Quality approval alone cannot authorize store publication. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J04; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### creative.media.attach

Attach approved media to named products. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef; assetRefs: ArtifactList. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant creative.media.attach. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: product media, alt text. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: File processing and product attachment both verify successfully. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J04; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Merchandising and analytics

### analytics.report.create

Compute a governed business report. Owner: Morrow platform owner. Effect: internal_write. Provider: analytics_data (D07, Design recorded).

Input: metricIds: IdList; period: PeriodRef; storeIds: IdList. Output: reportRef: ArtifactRef; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant analytics.report.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: aggregate metrics. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Metric definitions preserve currencies refunds and reporting windows. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J05; P10.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### analytics.anomaly.investigate

Investigate an aggregate anomaly. Owner: Morrow platform owner. Effect: internal_write. Provider: analytics_data (D07, Design recorded).

Input: metricId: Id; period: PeriodRef; baseline: EvidenceRef. Output: investigationRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant analytics.anomaly.investigate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: aggregate metrics, authorized contributing facts. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Coverage and hypotheses accompany the anomaly rather than invented causes. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J05; P10.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### analytics.assortment.propose

Recommend assortment from governed evidence. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: reportRef: ArtifactRef; inventoryEvidence: EvidenceList. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant analytics.assortment.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: assortment suggestions. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Recommendations retain stock constraints and underlying measurements. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J05; P10.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Paid acquisition

### ads.accounts.read

Discover eligible Meta ad accounts. Owner: Morrow platform owner. Effect: read. Provider: meta_ads (D08, Design recorded).

Input: connectionId: Id. Output: accounts: AccountList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant ads.accounts.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: account identity, role, status. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: No account outside the verified connection grant is returned. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J06; P17.T02, P17.T01; P01.A01, P17.A02. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### ads.performance.read

Read named account advertising performance. Owner: Morrow platform owner. Effect: read. Provider: meta_ads (D08, Design recorded).

Input: accountIds: IdList; period: PeriodRef; attribution: AttributionRef. Output: rows: AdMetricList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant ads.performance.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: spend, impressions, clicks, provider attribution. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: Attribution windows and account currency remain explicit. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J06; P17.T02, P17.T01; P01.A01, P17.A02. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### ads.campaign.propose

Prepare campaign structure and creative. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: accountId: Id; objective: string; audience: AudienceRef; assets: ArtifactList; budget: MoneyRef. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant ads.campaign.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: campaign, ad set, creative, targeting, budget. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Exact account audience assets and spend ceiling are reviewable. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J06; P17.T02, P17.T01; P01.A01, P17.A02. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### ads.campaign.create_paused

Create approved paused campaign objects. Owner: Morrow platform owner. Effect: external_write. Provider: meta_ads (D08, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; providerIds: IdList; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant ads.campaign.create_paused. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: paused campaign, ad set, creative, ad. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Readback confirms paused status; no activation follows implicitly. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J06; P17.T02, P17.T01; P01.A01, P17.A02. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### ads.campaign.activate

Activate an approved ad delivery plan. Owner: Morrow platform owner. Effect: spend. Provider: meta_ads (D08, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef; budget: BudgetRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant ads.campaign.activate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: delivery status, explicit budget. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R04. Verification: Current spend grant and reserved ceiling match the approved account. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J06; P17.T02, P17.T01; P01.A01, P17.A02. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### ads.budget.change

Change a specifically approved campaign budget. Owner: Morrow platform owner. Effect: spend. Provider: meta_ads (D08, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef; budget: BudgetRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant ads.budget.change. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: daily or lifetime budget. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R04. Verification: Budget type currency ceiling and provider readback match. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J06; P17.T02, P17.T01; P01.A01, P17.A02. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### ads.campaign.pause

Pause delivery on named advertising objects. Owner: Morrow platform owner. Effect: external_write. Provider: meta_ads (D08, Design recorded).

Input: campaigns: CampaignRefs; control: KillSwitchControl. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant ads.campaign.pause. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: delivery status. Executor: human_only; kill switch. Review gate: none; a kill switch executes without a second approver but needs a current human grant, a recorded reason, an append-only KillSwitchRecord and owner notification (ADR-0005).

Retention: R02. Verification: Pause is verified and is not represented as retroactive spend reversal. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J06; P17.T02, P17.T01; P01.A01, P17.A02. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### ads.audience.select

Select an existing authorized audience. Owner: Morrow platform owner. Effect: read. Provider: meta_ads (D08, Design recorded).

Input: accountId: Id; audienceIds: IdList. Output: audiences: AudienceList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant ads.audience.select. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: audience metadata excluding raw customer data. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: Selection remains inside account and targeting grants. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J06; P17.T02, P17.T01; P01.A01, P17.A02. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Lifecycle marketing

### lifecycle.segment.read

Read consent-aware segment definitions and counts. Owner: Morrow platform owner. Effect: read. Provider: lifecycle_provider (D09, Design recorded).

Input: segmentIds: IdList; channel: string. Output: segments: SegmentList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant lifecycle.segment.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: segment definition, count, consent coverage. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R03. Verification: Aggregate segments do not expose raw contact lists by default. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J07; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### lifecycle.campaign.propose

Draft campaign content and recipient scope. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: segmentId: Id; channel: string; brandEvidence: EvidenceList. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant lifecycle.campaign.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: subject, body, segment, schedule. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R03. Verification: Claims recipient scope and channel are exact and reviewable. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J07; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### lifecycle.campaign.create_draft

Create an approved unsent provider campaign. Owner: Morrow platform owner. Effect: external_write. Provider: lifecycle_provider (D09, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant lifecycle.campaign.create_draft. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: unsent campaign fields. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Provider confirms draft state without scheduling or sending. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J07; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### lifecycle.campaign.send

Send or schedule an approved channel campaign. Owner: Morrow platform owner. Effect: communication. Provider: lifecycle_provider (D09, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef; consentEvidence: EvidenceList. Output: operationId: Id; deliveryReceipt: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant lifecycle.campaign.send. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: channel, recipients, content, schedule. Executor: agent_after_approval; irreversible (ADR-0011 Q4: the irreversible review rule is merged in). Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Consent suppression recipient scope and provider acceptance are verified. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J07; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### lifecycle.performance.read

Read campaign delivery and conversion evidence. Owner: Morrow platform owner. Effect: read. Provider: lifecycle_provider (D09, Design recorded).

Input: campaignIds: IdList; period: PeriodRef. Output: rows: LifecycleMetricList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant lifecycle.performance.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: aggregate delivery, click, conversion data. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R03. Verification: Delivery success is distinguished from attributed business outcomes. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J07; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Customer support

### support.case.read

Read a permitted customer case and linked facts. Owner: Morrow platform owner. Effect: read. Provider: support_provider (D10, Design recorded).

Input: caseId: Id; allowedFields: FieldList. Output: case: CaseRef; evidence: EvidenceList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant support.case.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: case transcript, permitted customer and order fields. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R03. Verification: Protected fields are filtered and case access is attributable. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J08; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### support.reply.propose

Draft a grounded reply for review. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: caseId: Id; caseEvidence: EvidenceList; policyEvidence: EvidenceList. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant support.reply.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: reply body, recipient, channel. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R03. Verification: Reply cites policy and authorized order facts without invented promises. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J08; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### support.reply.send

Send an exact approved customer reply. Owner: Morrow platform owner. Effect: communication. Provider: support_provider (D10, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; deliveryReceipt: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant support.reply.send. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: recipient, channel, reply body. Executor: agent_after_approval; irreversible (ADR-0011 Q4: the irreversible review rule is merged in). Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Provider message identity verifies the exact approved recipient and body. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J08; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### support.case.escalate

Assign or escalate an eligible case. Owner: Morrow platform owner. Effect: external_write. Provider: support_provider (D10, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant support.case.escalate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: assignee, priority, escalation reason. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Case changes do not grant refund or order authority. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J08; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### support.case.close

Close a reviewed eligible support case. Owner: Morrow platform owner. Effect: external_write. Provider: support_provider (D10, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant support.case.close. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: case status. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Current case state and closure reason match the approved transition. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J08; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Orders and fulfillment

### orders.read

Read authorized order and fulfillment state. Owner: Morrow platform owner. Effect: read. Provider: shopify (D02, Design recorded).

Input: orderIds: IdList; allowedFields: FieldList. Output: orders: OrderList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant orders.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: allowed order, fulfillment, return fields. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R03. Verification: Order age and protected-data coverage remain explicit. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J09; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### orders.exceptions.triage

Prepare an order exception work queue. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: orderEvidence: EvidenceList; policyEvidence: EvidenceList. Output: queueRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant orders.exceptions.triage. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: order exceptions, owner, proposed next action. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R03. Verification: Triage cannot change orders or communicate automatically. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J09; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### orders.cancel

Cancel an exact eligible order. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant orders.cancel. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: cancellation fields and declared consequences. Executor: agent_after_approval; irreversible (ADR-0011 Q4: the irreversible review rule is merged in). Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Financial and restock consequences are separately bound in the proposal. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J09; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### orders.fulfillment.create

Create an approved eligible fulfillment. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant orders.fulfillment.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: fulfillment order, line quantities, tracking. Executor: agent_after_approval; irreversible (ADR-0011 Q4: the irreversible review rule is merged in). Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Assigned fulfillment service and remaining quantities are validated. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J09; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### orders.fulfillment.tracking_update

Update approved tracking details. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant orders.fulfillment.tracking_update. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: tracking company, number, URL. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Tracking readback matches the named fulfillment and proposal. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J09; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### orders.return.create

Create an approved return for selected lines. Owner: Morrow platform owner. Effect: external_write. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant orders.return.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: return lines, quantities, reason. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R03. Verification: Return creation is distinct from refund and restock completion. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J09; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### orders.refund.create

Issue a specifically approved bounded refund. Owner: Morrow platform owner. Effect: spend. Provider: shopify (D02, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef; budget: BudgetRef. Output: operationId: Id; transactionEvidence: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant orders.refund.create. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: refund amount, currency, lines, shipping, restock consequences. Executor: agent_after_approval; irreversible (ADR-0011 Q4: the irreversible review rule is merged in). Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R04. Verification: Refund record and transaction status both reconcile without duplicate payment. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J09; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Inventory

### inventory.levels.read

Read inventory by authorized item and location. Owner: Morrow platform owner. Effect: read. Provider: inventory_authority (D11, Design recorded).

Input: itemIds: IdList; locationIds: IdList. Output: levels: InventoryList; freshness: FreshnessRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant inventory.levels.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: item, location, available quantity. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: Configured stock authority and observation time accompany quantities. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J10; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### inventory.risk.report

Report stock risk against demand evidence. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: inventoryEvidence: EvidenceList; demandEvidence: EvidenceList. Output: reportRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant inventory.risk.report. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: stock coverage, forecast hypotheses. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Predicted demand remains distinct from authoritative stock. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J10; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### inventory.adjust.propose

Draft a scoped inventory adjustment. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: itemId: Id; locationId: Id; delta: integer; reason: string; sourceEvidence: EvidenceList. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant inventory.adjust.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: item, location, delta, reason. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Adjustment identifies the configured stock authority and prior state. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J10; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### inventory.quantity.adjust

Apply an approved delta at the authoritative system. Owner: Morrow platform owner. Effect: external_write. Provider: inventory_authority (D11, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant inventory.quantity.adjust. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: quantity delta, location, reason. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Current authority and provider result verify one logical adjustment. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J10; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### inventory.quantity.set

Set an approved absolute quantity under source authority. Owner: Morrow platform owner. Effect: external_write. Provider: inventory_authority (D11, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef; expectedQuantity: integer. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant inventory.quantity.set. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: absolute quantity, location, compare quantity. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Absolute write requires source-of-truth authority and concurrency precondition. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J10; P17.T02, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Finance

### finance.costs.read

Read explicitly authorized cost evidence. Owner: Morrow platform owner. Effect: read. Provider: finance_data (D12, Design recorded).

Input: resourceIds: IdList; period: PeriodRef. Output: costs: CostList; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant finance.costs.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: unit cost, fees, shipping costs. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R04. Verification: Finance field grants and missing cost evidence are explicit. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J11; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### finance.margin.report

Calculate margins from governed cost and refund evidence. Owner: Morrow platform owner. Effect: internal_write. Provider: finance_data (D12, Design recorded).

Input: costEvidence: EvidenceList; revenueEvidence: EvidenceList; metricId: Id. Output: reportRef: ArtifactRef; coverage: CoverageRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant finance.margin.report. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: cost, refund, revenue, margin metrics. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R04. Verification: Currency missing costs and estimation assumptions are retained. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J11; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### finance.reconciliation.propose

Prepare a discrepancy reconciliation task. Owner: Morrow platform owner. Effect: internal_write. Provider: finance_data (D12, Design recorded).

Input: statementRefs: ArtifactList; transactionEvidence: EvidenceList. Output: reconciliationRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant finance.reconciliation.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: discrepancies, source records, proposed investigation. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R04. Verification: No ledger write payout tax filing or transfer follows the report. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J11; P17.T03, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Storefront

### storefront.ux.audit

Inspect public storefront UX and accessibility. Owner: Morrow platform owner. Effect: read. Provider: public_web (D03, Design recorded).

Input: urls: UrlList; journeys: StringList; viewports: ViewportList. Output: auditRef: ArtifactRef; evidence: EvidenceList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant storefront.ux.audit. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: public pages, interaction observations. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R01. Verification: Evidence records viewport and excludes invented conversion uplift. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J12; P17.T04, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### storefront.change.propose

Draft an evidence-backed storefront change. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: auditRef: ArtifactRef; themeId: Id; brief: string. Output: proposalRef: ProposalRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant storefront.change.propose. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: selected files or app-owned extension changes. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Theme edits and extension changes use distinct delivery paths. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J12; P17.T04, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### storefront.extension.prepare

Prepare an app-owned extension release. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: sourceRef: ArtifactRef; configuration: ConfigRef. Output: releaseRef: ReleaseRef; previewRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant storefront.extension.prepare. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: app-owned extension source, configuration. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Preview and compatibility evidence precede merchant activation. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J12; P17.T04, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### storefront.extension.activate

Activate an approved app-owned extension configuration. Owner: Morrow platform owner. Effect: external_write. Provider: shopify_extension (D13, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant storefront.extension.activate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: app-owned configuration. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: If no supported API exists use a recorded human handoff; no unrestricted theme write. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J12; P17.T04, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### storefront.theme.preview_write

Write approved changes to a non-live theme. Owner: Morrow platform owner. Effect: external_write. Provider: shopify_theme (D14, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; previewRef: ArtifactRef; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant storefront.theme.preview_write. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: allowlisted theme files, non-live theme. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Required permission exemption base files and non-live target are checked. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J12; P17.T04, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### storefront.theme.publish

Publish an exact approved theme revision. Owner: Morrow platform owner. Effect: external_write. Provider: shopify_theme (D14, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: operationId: Id; readback: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant storefront.theme.publish. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: live theme selection. Executor: agent_after_approval. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Publication verifies selected theme revision and retains rollback evidence. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J12; P17.T04, P17.T01; P01.A01, P17.A04. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Governance

### governance.membership.invite

Invite a person with explicitly bounded grants. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: identity: string; grantProposal: GrantRef. Output: invitationId: Id.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.membership.invite. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: membership, proposed grants. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Invitation cannot delegate authority beyond inviter scope. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.grants.revise

Approve and apply a bounded grant revision. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: grantRevision: Revision; auditId: Id.

Authority: eligible_human_reviewer_with_explicit_decision_grant; explicit grant governance.grants.revise. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: capability, resource, field, expiry constraints. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: No principal grants permissions outside their administration authority. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.membership.revoke

Revoke membership sessions and active grants. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: membershipId: Id; control: KillSwitchControl. Output: revocationId: Id; affectedRuns: IdList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.membership.revoke. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: membership, session revocation. Executor: human_only; kill switch. Review gate: none; a kill switch executes without a second approver but needs a current human grant, a recorded reason, an append-only KillSwitchRecord and owner notification (ADR-0005).

Retention: R02. Verification: Next dispatch and retrieval honor revocation across hosts and waits. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.connection.connect

Bind a verified provider account to a workspace. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: providerId: Id; installationProof: ProofRef; scope: ScopeRef. Output: connectionId: Id; grants: GrantRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.connection.connect. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: provider account, scope, vault reference. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Ownership is verified without email equality or client shop ID trust. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.connection.disconnect

Revoke connection access and stop dependent dispatch. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: connectionId: Id; control: KillSwitchControl. Output: revocationId: Id; affectedRuns: IdList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.connection.disconnect. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: connection state, credential revocation. Executor: human_only; kill switch. Review gate: none; a kill switch executes without a second approver but needs a current human grant, a recorded reason, an append-only KillSwitchRecord and owner notification (ADR-0005).

Retention: R02. Verification: Submitted effects reconcile after dispatch is disabled. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.approval.decide

Approve or reject an immutable proposal. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: proposalRef: ProposalRef; decision: ReviewDecisionInput; expectedRevision: Revision. Output: approvalId: Id; proposalDigest: string.

Authority: eligible_human_reviewer_with_explicit_decision_grant; explicit grant governance.approval.decide. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: exact resources, fields, parameters, cost, expiry. Executor: human_only. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Eligible reviewer binds the decision to one exact proposal digest. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.approval.preview

Preview the exact proposal a decision binds. Owner: Morrow platform owner. Effect: read. Provider: morrow (D01, Design recorded).

Input: proposalRef: ProposalRef; selectedTargetIndexes: TargetSelection. Output: proposal: Proposal.

Authority: eligible_human_reviewer_with_explicit_decision_grant; explicit grant governance.approval.preview. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: exact resources, fields, parameters, cost, expiry. Executor: human_only. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Derived digest equals the one the decision binds. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P11.T01, P14.T03; P01.A01, P11.A01, P14.A03. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.review_policy.revise

Approve and apply a workspace review policy revision. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: policyRef: PolicyRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.review_policy.revise. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: review rules, quorum, expiry, self-approval. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: A new revision invalidates approvals bound to the old one. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P11.T01; P01.A01, P11.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.usage.read

Read scoped usage reservations and actual costs. Owner: Morrow platform owner. Effect: read. Provider: morrow (D01, Design recorded).

Input: scope: ScopeRef; period: PeriodRef. Output: usage: UsageList; liabilities: LiabilityList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.usage.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: authorized usage and costs. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Consumption is separate from subscription entitlement and task budget. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.budget.revise

Revise a reviewed scoped spending ceiling. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: proposalRef: ProposalRef; approvalRef: ApprovalRef. Output: budgetRevision: Revision.

Authority: eligible_human_reviewer_with_explicit_decision_grant; explicit grant governance.budget.revise. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: task or cost-center budget. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Changing a ceiling cannot erase reservations or existing liabilities. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.audit.export

Export authorized attributable audit records. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: scope: ScopeRef; period: PeriodRef. Output: exportRef: ArtifactRef; manifest: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.audit.export. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: authorized audit records. Executor: human_only. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Export access and expiry preserve source restrictions. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.privacy.export

Prepare a scoped subject data export. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: subjectRef: SubjectRef; verifiedRequest: ProofRef. Output: exportRef: ArtifactRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.privacy.export. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: verified subject data. Executor: human_only. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Identity verification and restricted delivery protect the export. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### governance.privacy.erase

Execute a verified bounded deletion request. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: subjectRef: SubjectRef; verifiedRequest: ProofRef; approvalRef: ApprovalRef. Output: deletionReceipt: EvidenceRef; retainedBasis: EvidenceList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant governance.privacy.erase. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: subject records and permitted derived content. Executor: human_only; irreversible (ADR-0011 Q4: the irreversible review rule is merged in). Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Deletion replay covers projections artifacts and restored data with explicit retention exceptions. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J13; P05.T01, P17.T01; P01.A01, P05.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Custom agents

### agents.listing.read

Read eligible agent listings and requirements. Owner: Morrow platform owner. Effect: read. Provider: morrow (D01, Design recorded).

Input: filters: FilterRef. Output: listings: ListingList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant agents.listing.read. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: public listing and authorized readiness fields. Executor: agent_direct_read. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Listing does not claim unavailable providers or unqualified outcomes. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.builder.describe

Compile a role description into a draft specification. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: description: string; scope: ScopeRef. Output: draftRelease: ReleaseRef; questions: QuestionList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant agents.builder.describe. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: purpose, proposed skills, inputs, outputs, capabilities. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Only catalogue capabilities may be proposed; missing inputs become questions. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.installation.stage

Stage a pinned release and bounded configuration. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow (D01, Design recorded).

Input: releaseRef: ReleaseRef; configuration: ConfigRef; grantProposal: GrantRef. Output: installationRevision: Revision.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant agents.installation.stage. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: release lockfile, configuration, proposed grants. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Staging does not activate routines or grant new authority. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.installation.sample

Run a bounded evaluated installation sample. Owner: Morrow platform owner. Effect: billable_job. Provider: morrow_runtime (D15, Design recorded).

Input: installationId: Id; revision: Revision; fixture: ArtifactRef; budget: BudgetRef. Output: runId: Id; resultRef: ArtifactRef; costReceipt: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant agents.installation.sample. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: qualified fixture, permitted context. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R02. Verification: Sample uses provisional authority and normal effect gates. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.installation.activate

Activate a qualified installation revision. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: installationId: Id; revision: Revision; evaluation: EvidenceRef; grant: GrantRef. Output: activationId: Id.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant agents.installation.activate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: pinned dependencies, configuration, grants. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Activation is atomic and does not broaden owner or initiating grants. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.installation.upgrade

Stage and switch an evaluated pinned revision. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: installationId: Id; releaseRef: ReleaseRef; evaluation: EvidenceRef. Output: activeRevision: Revision; retainedRunVersions: IdList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant agents.installation.upgrade. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: release lockfile, compatible overlays. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Failure preserves prior valid revision and does not duplicate routines. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.installation.disable

Suspend new installation runs and schedules. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: installationId: Id; control: KillSwitchControl. Output: status: InstallationStatus; pendingOperations: IdList.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant agents.installation.disable. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: dispatch and schedule state. Executor: human_only; kill switch. Review gate: none; a kill switch executes without a second approver but needs a current human grant, a recorded reason, an append-only KillSwitchRecord and owner notification (ADR-0005).

Retention: R02. Verification: Submitted jobs and liabilities remain visible. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.installation.uninstall

Remove an installation and revoke its authority. Owner: Morrow platform owner. Effect: control. Provider: morrow (D01, Design recorded).

Input: installationId: Id; expectedRevision: Revision. Output: receipt: EvidenceRef; retentionPlan: EvidenceRef.

Authority: human_or_bounded_installation_with_explicit_capability_grant; explicit grant agents.installation.uninstall. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: installation authority, routines. Executor: human_only; irreversible (ADR-0011 Q4: the irreversible review rule is merged in). Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R02. Verification: Uninstall does not reverse published changes or silently delete retained work. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.skill.research

Produce a sourced candidate skill dossier. Owner: Morrow platform owner. Effect: internal_write. Provider: morrow_authoring (D16, Design recorded).

Input: brief: string; sourcePolicy: PolicyRef. Output: skillCandidate: ReleaseRef; sourceDossier: ArtifactRef.

Authority: operator_with_explicit_authoring_grant; explicit grant agents.skill.research. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: approved research and fixture sources. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R05. Verification: Merchant credentials and production customer data never enter authoring. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.release.evaluate

Evaluate a candidate against versioned held-out cases. Owner: Morrow platform owner. Effect: billable_job. Provider: morrow_authoring (D16, Design recorded).

Input: releaseRef: ReleaseRef; suiteRef: EvaluationRef; budget: BudgetRef. Output: evaluation: EvidenceRef.

Authority: operator_with_explicit_authoring_grant; explicit grant agents.release.evaluate. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: candidate dependencies, approved fixtures. Executor: agent_direct_write. Review gate: no action approval by default; grants and other policy gates still apply.

Retention: R05. Verification: Task quality routing authority and efficiency have separate results. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.release.publish

Publish a reviewed qualified first-party release. Owner: Morrow platform owner. Effect: control. Provider: morrow_authoring (D16, Design recorded).

Input: releaseRef: ReleaseRef; evaluation: EvidenceRef; review: ReviewRef. Output: publishedRelease: ReleaseRef.

Authority: operator_with_explicit_authoring_grant; explicit grant agents.release.publish. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: immutable digest, listing, publication state. Executor: human_only. Review gate: required for this proposed contract; exact eligible decision/mandate semantics settle in P01.T02.

Retention: R05. Verification: Merchant ownership confers no first-party publishing authority. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

### agents.release.revoke

Quarantine a release and suspend affected capabilities. Owner: Morrow platform owner. Effect: control. Provider: morrow_authoring (D16, Design recorded).

Input: releaseRef: ReleaseRef; control: KillSwitchControl. Output: revocationReceipt: EvidenceRef; affectedInstallations: IdList.

Authority: operator_with_explicit_authoring_grant; explicit grant agents.release.revoke. Trusted organization/workspace; explicit stores and connection account; selected resources; installation mandate intersection; operator namespace isolated when applicable. Fields: release status, affected dispatch. Executor: human_only; kill switch. Review gate: none; a kill switch executes without a second approver but needs a current human grant, a recorded reason, an append-only KillSwitchRecord and owner notification (ADR-0005).

Retention: R05. Verification: Emergency revocation overrides run pinning and retains recovery evidence. Failure: Deny without leaking inaccessible facts; request missing input separately. Conflict requires reread. Uncertain external effect requires reconciliation, never blind replay.

Trace: J14; P16.T01, P17.T01; P01.A01, P16.A01. Complete domain workflow in standalone Morrow; connector context cannot dispatch it; Same workflow and record IDs; secondary panels collapse to tabs or drawers at narrow content widths.

## Retention classes

- R01, Commerce projections: Permission-filtered mirror with source timestamps and tombstones; configurable retention awaits P01.T02; no launch until settled.
- R02, Work and artifacts: Scoped versioned work and source restrictions; deletion propagation and configurable retention await P01.T02.
- R03, Protected customer records: Minimum required fields only; subject deletion export and access receipts; durations and exceptions await P01.T02.
- R04, Financial and effect evidence: Restricted liability operation and audit records; deletion versus necessary retention must be resolved in P01.T02.
- R05, Operator research fixtures: Approved public sources and synthetic fixtures only; immutable published release provenance; retention contract awaits P01.T02.
