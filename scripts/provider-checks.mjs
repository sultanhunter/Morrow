// Documentary gate checks for P01. This module cannot enable a connector or
// authorize dispatch. Later services must verify actual current evidence.
export function validateProviders(registry, bindings, catalogue, dependencies, sources, planSequence) {
  const errors=[];
  const fail=message=>errors.push(message);
  const providers=new Map(registry.providers.map(p=>[p.id,p]));
  const caps=new Map(catalogue.capabilities.map(c=>[c.id,c]));
  const deps=new Set(dependencies.map(d=>d.id));
  const sourceMap=new Map(sources.map(s=>[s.id,s]));
  if(providers.size!==registry.providers.length) fail('duplicate provider');
  for(const document of [registry,bindings]) {
    if(document.schema_version!==1 || !Number.isInteger(document.plan_sequence) || document.plan_sequence>planSequence) fail('unrecorded provider decision revision');
  }
  for(const p of providers.values()) {
    if(!p.id || !p.owner || !p.version || !p.test_account_plan || !p.restrictions || !p.blocking_packages.length || p.decision_ids.some(d=>!deps.has(d))) fail(`${p.id}: missing provider ownership or qualification plan`);
    if(p.design_status!=='selected' || p.activation!=='blocked' || p.engineering_status!=='not_implemented' || p.controlled_test_status!=='not_run' || !['pending','not_applicable'].includes(p.production_review_status) || p.qualification_evidence.length!==0) fail(`${p.id}: unsupported activation/qualification claim`);
    for(const id of p.sources) if(sourceMap.get(id)?.status!=='verified') fail(`${p.id}: documentary source unverified ${id}`);
  }
  const seen=new Set();
  for(const b of bindings.bindings) {
    const c=caps.get(b.capability),p=providers.get(b.provider);
    if(seen.has(b.capability)) fail(`${b.capability}: duplicate binding`);
    seen.add(b.capability);
    if(!c || !p) {fail(`${b.capability}: unknown capability/provider`);continue;}
    if(b.provider_dependency!==c.provider_dependency || !p.decision_ids.includes(b.provider_dependency)) fail(`${b.capability}: wrong decision linkage`);
    if(b.version!==p.version || /latest|\*/i.test(b.version)) fail(`${b.capability}: unpinned provider boundary`);
    if(b.effect!==c.effect || JSON.stringify([...b.hosts].sort())!==JSON.stringify(['standalone'])) fail(`${b.capability}: effect or surface drift`);
    if(!['api','model','runtime','projection','internal','human_handoff'].includes(b.mode) || !b.operations?.length || b.operations.some(x=>typeof x!=='string'||!x.trim()) || !b.readback?.trim() || !b.logical_idempotency?.trim() || !b.unknown_outcome?.trim()) fail(`${b.capability}: missing operation/outcome contract`);
    if(!Array.isArray(b.required_scopes) || b.required_scopes.some(x=>typeof x!=='string'||!x.trim()||x.includes('*')||x==='write:all')) fail(`${b.capability}: unrestricted or invalid scope`);
    if(b.activation!=='blocked' || b.scope_status!=='pending_conformance') fail(`${b.capability}: provider access is not qualified`);
    if(b.mode==='api' && !b.sources.length) fail(`${b.capability}: external API lacks source`);
    for(const id of b.sources) if(sourceMap.get(id)?.status!=='verified') fail(`${b.capability}: unverified documentary source ${id}`);
    if(!b.conformance_tasks.length || b.conformance_tasks.some(id=>!c.implementation_tasks.includes(id))) fail(`${b.capability}: missing implementation/conformance linkage`);
  }
  for(const id of caps.keys()) if(!seen.has(id)) fail(`${id}: missing provider binding`);
  return errors;
}

// A recorded design can make a local implementation task ready while live
// activation remains blocked. This is a planning result, never an access grant.
export function inspectReadiness(packet, decisions) {
  const reasons=[];
  const byId=new Map(decisions.map(d=>[d.id,d]));
  if(!Array.isArray(packet.consumedDecisions)||!packet.consumedDecisions.length) reasons.push('DECISION_INPUTS_MISSING');
  for(const id of packet.consumedDecisions??[]) {
    const d=byId.get(id);
    if(!d || d.status!=='recorded' || !d.reviewRef) reasons.push(`STRUCTURAL_DECISION_UNRESOLVED:${id}`);
  }
  if(!packet.acceptanceIds?.length || !packet.verification?.length) reasons.push('ACCEPTANCE_OR_VERIFICATION_MISSING');
  if(packet.requiresControlledAccount && !packet.controlledAccountRef) reasons.push('CONTROLLED_ACCOUNT_MISSING');
  if(packet.requiresQualifiedPackage && packet.packageInputStatus!=='qualified') reasons.push('PACKAGE_INPUT_UNQUALIFIED');
  return {ready:reasons.length===0,reasons};
}

// Used ONLY to challenge the distinction between planning and activation with
// synthetic facts. No documentary "verified" flag is accepted as a grant.
export function inspectSyntheticActivation(facts) {
  const reasons=[];
  if(facts.host!=='standalone') reasons.push('HOST_INVALID');
  if(facts.engineering!=='qualified') reasons.push('ENGINEERING_UNQUALIFIED');
  if(facts.controlledTest!=='passed') reasons.push('CONTROLLED_TEST_UNQUALIFIED');
  if(facts.productionReviewRequired && (facts.productionReview!=='granted'||!facts.productionReviewRef)) reasons.push('PRODUCTION_PERMISSION_PENDING');
  if(!facts.currentAccountPermission) reasons.push('ACCOUNT_PERMISSION_MISSING');
  if(!facts.currentActorPermission) reasons.push('ACTOR_PERMISSION_MISSING');
  if(!facts.currentRegionAndRetention) reasons.push('DATA_POLICY_UNQUALIFIED');
  if(facts.requiresSpend && !facts.budgetReserved) reasons.push('BUDGET_NOT_RESERVED');
  if(facts.requiresReview && !facts.exactCurrentApproval) reasons.push('EXACT_APPROVAL_MISSING');
  if(facts.remainingStructuralGap) reasons.push('STRUCTURAL_GAP');
  return {allowed:reasons.length===0,reasons};
}
