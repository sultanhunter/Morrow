// Test-only proposal producers (P06.T01b exact outputs). The production producer
// registry is empty until P05.T01z and P05.T02a register theirs; the boundary
// check forbids importing this file from packages/ or apps/. Targets are the
// workspace W only, and target fields are input names of the capability
// (ADR-0009 item 7: governance grant fields are input property names).
import { validateCurrentDefinition } from "../../packages/contracts/src/validation.ts";

const closed = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const workspace = (tenant) => ({
  organizationId: tenant.organizationId,
  workspaceId: tenant.workspaceId,
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: tenant.workspaceId,
});

/** governance.grants.revise: one W target for one beneficiary; all or nothing. */
export const grantsReviseProducer = Object.freeze({
  capabilityId: "governance.grants.revise",
  partialApproval: "all_or_nothing",
  parse(value) {
    if (!closed(value, ["beneficiaryPrincipalId"])) return null;
    if (!validateCurrentDefinition("Id", value.beneficiaryPrincipalId)) return null;
    return { beneficiaryPrincipalId: value.beneficiaryPrincipalId };
  },
  plan(p, tenant) {
    return {
      targets: [
        {
          resource: workspace(tenant),
          expectedSourceRevision: "grants:" + p.beneficiaryPrincipalId,
          fields: ["approvalRef", "proposalRef"],
          maximumCredits: "0",
          maximumCost: null,
        },
      ],
      beneficiaryPrincipalIds: [p.beneficiaryPrincipalId],
    };
  },
});

/**
 * governance.privacy.erase (control, irreversible): one W target per subject,
 * fields ["subjectRef"], distinct expectedSourceRevision; partial approval allowed.
 * `credits` lets a case give the targets ceilings; `targets` may exceed the cap.
 */
export const privacyEraseProducer = Object.freeze({
  capabilityId: "governance.privacy.erase",
  partialApproval: "allowed",
  parse(value) {
    if (!closed(value, ["subjects"]) || !Array.isArray(value.subjects)) return null;
    if (value.subjects.length < 1 || value.subjects.length > 200) return null;
    if (!value.subjects.every((s) => validateCurrentDefinition("Id", s))) return null;
    if (new Set(value.subjects).size !== value.subjects.length) return null;
    return { subjects: [...value.subjects] };
  },
  plan(p, tenant) {
    return {
      targets: p.subjects.map((subject, i) => ({
        resource: workspace(tenant),
        expectedSourceRevision: "subject:" + subject,
        fields: ["subjectRef"],
        maximumCredits: String(i + 1),
        maximumCost: null,
      })),
      beneficiaryPrincipalIds: [],
    };
  },
});

/** A producer whose plan names a target outside W (TENANT_MISMATCH → invalid). */
export const foreignTargetProducer = Object.freeze({
  capabilityId: "governance.budget.revise",
  partialApproval: "all_or_nothing",
  parse(value) {
    return closed(value, ["workspaceId"]) && validateCurrentDefinition("Id", value.workspaceId)
      ? { workspaceId: value.workspaceId }
      : null;
  },
  plan(p, tenant) {
    return {
      targets: [
        {
          resource: workspace({ ...tenant, workspaceId: p.workspaceId }),
          expectedSourceRevision: "budget",
          fields: ["approvalRef", "proposalRef"],
          maximumCredits: "0",
          maximumCost: null,
        },
      ],
      beneficiaryPrincipalIds: [],
    };
  },
});

/**
 * workspace.routine.activate (control, reviewed, not paid work, outside the
 * Governance domain): ADR-0018 requires a task for it.
 */
export const routineActivateProducer = Object.freeze({
  capabilityId: "workspace.routine.activate",
  partialApproval: "all_or_nothing",
  parse(value) {
    return closed(value, ["routineId"]) && validateCurrentDefinition("Id", value.routineId)
      ? { routineId: value.routineId }
      : null;
  },
  plan(p, tenant) {
    return {
      targets: [
        {
          resource: workspace(tenant),
          expectedSourceRevision: "routine:" + p.routineId,
          fields: ["expectedRevision", "mandate", "routineId"],
          maximumCredits: "0",
          maximumCost: null,
        },
      ],
      beneficiaryPrincipalIds: [],
    };
  },
});

export const approvalProducers = new Map([
  [grantsReviseProducer.capabilityId, grantsReviseProducer],
  [privacyEraseProducer.capabilityId, privacyEraseProducer],
  [foreignTargetProducer.capabilityId, foreignTargetProducer],
  [routineActivateProducer.capabilityId, routineActivateProducer],
]);
