import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import canonicalize from 'canonicalize';
import {read,sha} from './foundation.mjs';

if (Number(process.versions.node.split('.')[0])!==24) throw new Error('Contract checks require the pinned Node 24 runtime');
export const core=read('docs/contracts/schemas/v1/core.schema.json');
export const bodies=read('docs/contracts/schemas/v1/capabilities.schema.json');
export const ajv=new Ajv2020({strict:true,allErrors:true,validateFormats:true,coerceTypes:false,useDefaults:false,removeAdditional:false});
addFormats(ajv);
ajv.addSchema(core);ajv.addSchema(bodies);
export const validators=Object.fromEntries(Object.keys(core.$defs).map(name=>[name,ajv.compile({$ref:core.$id+'#/$defs/'+name})]));
export const bodyValidators=Object.fromEntries(Object.keys(bodies.$defs).map(name=>[name,ajv.compile({$ref:bodies.$id+'#/$defs/'+name})]));
export const digest=value=>sha(canonicalize(value));
export function proposalDigest(proposal) { const {proposalDigest,...content}=proposal;return digest(content); }

// Executable examples for contract review, not runtime authentication or policy.
export function inspectBinding(context) {
  const c=structuredClone(context);
  const h=c.hostContext,p=c.proposal,a=c.approval;
  // Fixture setup resolves three canonical digests once, before case mutation.
  const errors=[];
  for (const [name,value] of [['HostContext',h],['Proposal',p],['Approval',a]]) if (!validators[name](value)) errors.push('SCHEMA_INVALID_'+name);
  if (errors.length) return errors;
  if (!c.trustedServerBootstrap) errors.push('UNAUTHENTICATED_HOST');
  if (!c.currentMembership) errors.push('MEMBERSHIP_REVOKED');
  if (h.organizationId!==h.principal.organizationId || h.workspaceId!==h.principal.workspaceId) errors.push('HOST_PRINCIPAL_MISMATCH');
  if (h.organizationId!==p.organizationId || h.workspaceId!==p.workspaceId || h.organizationId!==p.scope.organizationId || h.workspaceId!==p.scope.workspaceId) errors.push('WORKSPACE_MISMATCH');
  if (p.storeId!==c.requestedTargetStoreId) errors.push('TARGET_STORE_MISMATCH');
  const sameScope=r=>r.organizationId===p.organizationId && r.workspaceId===p.workspaceId && r.storeId===p.storeId;
  if (p.storeId!==null && (p.scope.storeIds.length!==1 || p.scope.storeIds[0]!==p.storeId)) errors.push('PROPOSAL_STORE_SCOPE_MISMATCH');
  if (!sameScope(p.parametersRef) || !sameScope(p.reviewPolicyRef)) errors.push('PAYLOAD_REFERENCE_SCOPE_MISMATCH');
  if (p.parametersRef.digest!==p.parametersDigest) errors.push('PARAMETERS_REFERENCE_DIGEST_MISMATCH');
  if (p.targets.some(t=>!sameScope(t.resource) || !p.scope.resources.some(r=>digest(r)===digest(t.resource)) || t.fields.some(field=>!p.scope.fields.includes(field)))) errors.push('TARGET_SCOPE_MISMATCH');
  if (a.reviewer && (a.reviewer.organizationId!==p.organizationId || a.reviewer.workspaceId!==p.workspaceId)) errors.push('REVIEWER_SCOPE_MISMATCH');
  if (!h.authorizedStoreIds.includes(p.storeId)) errors.push('STORE_DENIED');
  if (Date.parse(h.sessionExpiresAt)<=Date.parse(c.now)) errors.push('SESSION_EXPIRED');
  if (h.policyRevision!==c.currentPolicyRevision || a.policyRevision!==c.currentPolicyRevision) errors.push('POLICY_CHANGED');
  if (p.proposalDigest!==proposalDigest(p)) errors.push('PROPOSAL_DIGEST_MISMATCH');
  if (p.parametersDigest!==digest(c.parameters)) errors.push('PARAMETERS_DIGEST_MISMATCH');
  if (a.proposalRef.id!==p.id || a.proposalRef.revision!==p.revision) errors.push('PROPOSAL_REFERENCE_MISMATCH');
  if (a.proposalRef.organizationId!==p.organizationId || a.proposalRef.workspaceId!==p.workspaceId || a.proposalRef.storeId!==p.storeId || a.organizationId!==p.organizationId || a.workspaceId!==p.workspaceId || a.storeId!==p.storeId) errors.push('APPROVAL_REFERENCE_SCOPE_MISMATCH');
  if (a.proposalDigest!==p.proposalDigest || a.proposalRef.digest!==p.proposalDigest) errors.push('APPROVAL_DIGEST_MISMATCH');
  if (a.scopeDigest!==digest(p.scope)) errors.push('APPROVAL_SCOPE_MISMATCH');
  if (a.status!=='approved' || a.decision!=='approve' || Date.parse(a.expiresAt)<=Date.parse(c.now) || Date.parse(p.expiresAt)<=Date.parse(c.now)) errors.push('APPROVAL_NOT_CURRENT');
  if (!c.reviewerEligible || a.reviewer?.kind!=='human') errors.push('REVIEWER_DENIED');
  return errors;
}
export function inspectTransition(fixture) {
  const table=read('docs/contracts/state-transitions.json');
  return fixture.guardPassed && !!table.transitions[fixture.aggregate]?.some(t=>t.from===fixture.from&&t.to===fixture.to&&t.actor===fixture.actor&&t.guard===fixture.guard);
}
export function inspectHandoff(v) {
  return !v.consumed && Date.parse(v.expiresAt)>Date.parse(v.now) && v.boundPrincipalId===v.requestingPrincipalId && v.boundWorkspaceId===v.requestedWorkspaceId && v.boundInstallationId===v.requestedInstallationId && v.expectedOwnershipRevision===v.currentOwnershipRevision && !v.ownershipConflict && v.currentGrant;
}
export function checkFixture(f) {
  if (f.kind==='schema') return validators[f.definition](f.value)===f.valid;
  if (f.kind==='binding') return JSON.stringify(inspectBinding(f.context).sort())===JSON.stringify([...f.expectedErrors].sort());
  if (f.kind==='transition') return inspectTransition(f)===f.allowed;
  if (f.kind==='handoff') return inspectHandoff(f.value)===f.allowed;
  if (f.kind==='fence') return (f.value.expectedRevision===f.value.currentRevision&&f.value.requestedGeneration===f.value.currentGeneration)===f.allowed;
  throw new Error('Unknown fixture kind '+f.kind);
}
