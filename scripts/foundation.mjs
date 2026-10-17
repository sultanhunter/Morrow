import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
export const sha = value => createHash('sha256').update(value).digest('hex');

// Parent tasks are defined by numbered plan items ("1. **P01.T01 ..."), acceptance cases by
// their bold IDs ("**P01.A01:**"), both in plan order. Mentions are every ID the plan names.
export function planInventory(plan) {
  const all = pattern => [...plan.matchAll(pattern)].map(m => m[1]);
  return {
    tasks: all(/^[ \t]*\d+\. \*\*(P\d{2}\.T\d{2})(?![a-z\d])/gm),
    cases: all(/\*\*(P\d{2}\.A\d{2})(?![a-z\d])/g),
    mentionedTasks: [...new Set(plan.match(/P\d{2}\.T\d{2}(?![a-z\d])/g) ?? [])],
    mentionedCases: [...new Set(plan.match(/P\d{2}\.A\d{2}(?![a-z\d])/g) ?? [])],
  };
}

// Status vocabulary of docs/progress/tasks.json (plan "Working agreement and change control").
// Self-reviewed: complete with implementer review only while a required review or human gate is open.
export const TASK_STATUSES = Object.freeze(['Planned', 'Ready', 'In progress', 'In review', 'Self-reviewed', 'Verified', 'Blocked']);

export function validateTasks(tasks) {
  const errors = [];
  const ids = new Set();
  for (const t of tasks.tasks ?? []) {
    if (typeof t?.id !== 'string' || !/^P\d{2}\.T\d{2}$/.test(t.id) || ids.has(t.id)) errors.push(`invalid or duplicate task ID: ${t?.id}`);
    ids.add(t?.id);
    if (JSON.stringify(Object.keys(t ?? {}).sort()) !== '["id","status"]') errors.push(`${t?.id}: task record must have exactly id and status`);
    if (!TASK_STATUSES.includes(t?.status)) errors.push(`${t?.id}: unknown status ${JSON.stringify(t?.status)}`);
  }
  const cases = new Set();
  for (const id of tasks.acceptance_ids ?? []) {
    if (typeof id !== 'string' || !/^P\d{2}\.A\d{2}$/.test(id) || cases.has(id)) errors.push(`invalid or duplicate acceptance ID: ${id}`);
    cases.add(id);
  }
  return errors;
}

// Executor classes (ADR-0005 §2; P01.T02a §3). Rules R1-R11 replace the v1
// "consequential action without review gate" rule; R10 (irreversible) is ADR-0011 Q4.
export const EXECUTORS = Object.freeze(['human_only', 'agent_after_approval', 'agent_direct_write', 'agent_direct_read']);
const consequential = ['external_write', 'spend', 'communication'];

// `bodies` maps "<id>.input"/"<id>.output" to the effective body schema
// (contract-sources.mjs effectiveBodies); `types` is schema-types.json.
export function validateCatalogue(catalogue, dependencies, tasks, types, bodies) {
  const errors = [];
  if (catalogue.schema_version !== 2) errors.push('catalogue schema_version must be 2');
  const ids = new Set();
  const domains = new Set();
  const deps = new Set(dependencies.map(d => d.id));
  const taskIds = new Set(tasks.tasks.map(t => t.id));
  const cases = new Set(tasks.acceptance_ids);
  const effects = new Set(['read', 'internal_write', 'external_write', 'spend', 'communication', 'control', 'billable_job']);
  for (const c of catalogue.capabilities) {
    const fail = message => errors.push(`${c.id}: ${message}`);
    if (!/^[a-z]+(?:\.[a-z_]+)+$/.test(c.id)) fail('invalid stable ID');
    if (ids.has(c.id)) fail('duplicate capability');
    ids.add(c.id); domains.add(c.domain);
    for (const key of ['name','owner','eligible_principal','resource_scope','source_authority','verification','failure_behavior','journey']) {
      if (typeof c[key] !== 'string' || !c[key].trim()) fail(`missing ${key}`);
    }
    if (!effects.has(c.effect)) fail('invalid effect');
    if (c.grant !== c.id) fail('grant must be explicit capability ID');
    if (!deps.has(c.provider_dependency)) fail('untracked provider');
    if (!catalogue.retention_classes[c.retention_class]) fail('untracked retention');
    if (!c.field_scope?.length || c.field_scope.includes('*')) fail('missing or unrestricted fields');
    if (JSON.stringify([...c.hosts].sort()) !== JSON.stringify(['standalone'])) fail('standalone surface required');
    if (!c.layout?.trim()) fail('width adaptation missing');
    if (!EXECUTORS.includes(c.executor)) fail('R1 invalid executor');
    if (typeof c.kill_switch !== 'boolean' || typeof c.review_required !== 'boolean' || typeof c.irreversible !== 'boolean') fail('R1 kill_switch, irreversible and review_required must be booleans');
    if (c.effect === 'read' && !['agent_direct_read','human_only'].includes(c.executor)) fail('R2 read must be agent_direct_read or human_only');
    if (['internal_write','billable_job'].includes(c.effect) && c.executor === 'agent_direct_read') fail('R3 write must not be agent_direct_read');
    if (consequential.includes(c.effect) && !['agent_after_approval','human_only'].includes(c.executor)) fail('R4 consequential action must be agent_after_approval or human_only');
    if (c.effect === 'control' && c.executor !== 'human_only') fail('R5 control must be human_only');
    if (c.executor === 'agent_after_approval' && c.review_required !== true) fail('R6 agent_after_approval without review gate');
    if (c.kill_switch === true && (c.executor !== 'human_only' || c.review_required !== false || !['external_write','control'].includes(c.effect))) fail('R7 kill switch must be human_only, unreviewed and external_write or control');
    if (consequential.includes(c.effect) && c.review_required !== true && c.kill_switch !== true) fail('R8 consequential action without review gate must be a kill switch');
    if (c.eligible_principal?.startsWith('eligible_human_') && c.executor !== 'human_only') fail('R9 eligible human capability must be human_only');
    if (c.irreversible === true && c.effect === 'read') fail('R10 an irreversible capability cannot be a read');
    if (c.activation !== 'blocked_until_contract_and_provider_qualified') fail('premature activation');
    if (!c.implementation_tasks?.length || c.implementation_tasks.some(id => !taskIds.has(id))) fail('unknown implementation task');
    if (!c.acceptance_cases?.includes('P01.A01') || c.acceptance_cases.some(id => !cases.has(id))) fail('unknown acceptance case');
    for (const shape of ['input','output']) {
      if (!c[shape]?.envelope || !Object.keys(c[shape]?.fields ?? {}).length) fail(`missing ${shape} schema`);
      for (const [field, descriptor] of Object.entries(c[shape]?.fields ?? {})) {
        if (!types.types[descriptor.type] || descriptor.required !== true || descriptor.nullable !== false) fail(`invalid ${shape}.${field}`);
      }
      // R11: the catalogue describes the effective (current) body exactly.
      const body = bodies[`${c.id}.${shape}`];
      const fields = Object.keys(c[shape]?.fields ?? {}).sort();
      if (!body || JSON.stringify(Object.keys(body.properties ?? {}).sort()) !== JSON.stringify(fields) || JSON.stringify([...(body.required ?? [])].sort()) !== JSON.stringify(fields)) fail(`R11 ${shape} fields differ from the effective body`);
      else for (const [field, descriptor] of Object.entries(c[shape].fields)) if (types.types[descriptor.type]?.schema !== body.properties[field].$ref) fail(`R11 ${shape}.${field} type differs from the effective body`);
    }
  }
  for (const domain of catalogue.domain_names) if (!domains.has(domain)) errors.push(`missing launch domain: ${domain}`);
  if (domains.size !== catalogue.domain_names.length) errors.push('unexpected domain');
  for (const d of dependencies) {
    if (!taskIds.has(d.resolve_in) || !d.owner || !['Open','Design recorded'].includes(d.status) || d.activation !== 'blocked_until_qualified') errors.push(`invalid dependency gate: ${d.id}`);
    if (d.status === 'Design recorded' && (!Number.isInteger(d.design_sequence) || d.engineering_status !== 'not_implemented' || d.controlled_test_status !== 'not_run' || d.production_permission_status !== 'pending')) errors.push(`unsupported qualification claim: ${d.id}`);
  }
  return errors;
}

// Synthetic contract walkthrough only. It is not a production policy engine.
// A walkthrough models execution of the capability; agents may only propose
// human_only capabilities, which the agent kernel tests cover.
// Each context is a fixture representing facts the backend must later resolve.
export function inspectAuthority(c, request) {
  const failures = [];
  const { principal:p, origin, target, conditions:q } = request;
  if (request.host!=='standalone') failures.push('HOST_INVALID');
  if (p.revoked) failures.push('PRINCIPAL_REVOKED');
  if (p.tenant !== target.tenant || p.workspace !== target.workspace) failures.push('TENANT_OR_WORKSPACE_DENIED');
  if (!p.grants.includes(c.id)) failures.push('CAPABILITY_DENIED');
  if (!p.stores.includes(target.store)) failures.push('STORE_DENIED');
  if (!p.resources.includes(target.resource)) failures.push('RESOURCE_DENIED');
  if (!p.accounts.includes(target.account)) failures.push('ACCOUNT_DENIED');
  if (target.fields.some(f => !c.field_scope.includes(f) || !p.fields.includes(f))) failures.push('FIELD_DENIED');
  if (c.eligible_principal.startsWith('eligible_human') && p.kind !== 'human') failures.push('HUMAN_REVIEWER_REQUIRED');
  if (c.executor === 'human_only' && p.kind !== 'human') failures.push('HUMAN_EXECUTOR_REQUIRED');
  if (c.kill_switch && !(typeof q.killSwitchReason === 'string' && /\S/.test(q.killSwitchReason))) failures.push('KILL_SWITCH_REASON_REQUIRED');
  if (c.eligible_principal.startsWith('operator_') && !p.operator) failures.push('OPERATOR_AUTHORITY_REQUIRED');
  if (origin) {
    if (origin.revoked || origin.tenant !== target.tenant || origin.workspace !== target.workspace || !origin.grants.includes(c.id) || !origin.stores.includes(target.store) || !origin.resources.includes(target.resource) || !origin.accounts.includes(target.account) || target.fields.some(f => !origin.fields.includes(f))) failures.push('ORIGIN_SCOPE_DENIED');
  }
  if (p.kind === 'agent' && !origin) failures.push('ORIGIN_SCOPE_REQUIRED');
  if (p.kind === 'agent' && !q.mandateCurrent) failures.push('MANDATE_EXPIRED');
  if (!q.providerQualified) failures.push('PROVIDER_NOT_QUALIFIED');
  if (!q.providerPermission) failures.push('PROVIDER_PERMISSION_DENIED');
  // Kill switches are never blocked by entitlement or credit balance (ADR-0011 Q8); provider limits still apply.
  if (!q.entitled && !c.kill_switch) failures.push('ENTITLEMENT_DENIED');
  if (!q.sourceAuthorized) failures.push('SOURCE_AUTHORITY_DENIED');
  if (!q.preconditionCurrent) failures.push('PRECONDITION_CONFLICT');
  // Kill switches never need an exact approval (ADR-0005).
  if (c.review_required && !c.kill_switch && (q.approvedDigest !== q.proposalDigest || !q.approvalCurrent || !q.reviewerEligible)) failures.push('EXACT_APPROVAL_REQUIRED');
  if (['spend','billable_job'].includes(c.effect) && (!q.budgetReserved || BigInt(q.costMinor) > BigInt(q.ceilingMinor) || q.costCurrency !== q.ceilingCurrency)) failures.push('BUDGET_DENIED');
  return {allowed: failures.length === 0, reasons: failures};
}
