import type {
  Core_ActorRef,
  Current_AgentInstallation,
  Current_Grant,
  Current_ResourceRef,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { PermissionRequest } from "@morrow/policy";
import type {
  AgentAuthorityReader,
  CurrentActorAuthority,
  DelegationAuthorityFacts,
  DelegationEligibilityInput,
  DelegationHop,
  InstalledAgentAuthority,
} from "@morrow/policy/agent-authority";
import {
  entitlementFor,
  parseWorkspaceBillingFacts,
  workspaceBillingState,
  type BillingEnvironment,
} from "@morrow/policy/billing-state";
import type { DelegationFactsRow } from "../runtime/leases.js";
import type { BillingFactsReaderPort } from "./billing-facts-stub.js";

// The agent kernel's SQL fact reader (P05.T04b minimum; mvp-architecture §5 and §9). Inside
// one lease step, morrow_work.delegation_facts returns the envelope, its hops, the
// installations they name and the identity facts of every actor, read again on every call
// (the kernel reruns at every step). This reader assembles DelegationAuthorityFacts for
// createAgentAuthorityService().decideDelegation; it decides nothing itself. Providers are
// allowed while the lease's store association is current and no stop blocks the run.
// `entitlementAllowed` comes only from entitlementFor over the workspace's billing facts
// (M5 PR-1's reader; in this branch its fail-closed stub), which is why this function is on
// the inspectEntitlementWriters allowlist. Any missing or malformed fact throws, which the
// kernel reports as AGENT_POLICY_AUTHORITY_UNAVAILABLE: a denial.
export class DelegationFactsUnavailable extends Error {
  constructor() {
    super("DELEGATION_FACTS_UNAVAILABLE");
    this.name = "DelegationFactsUnavailable";
  }
}
const unavailable = () => new DelegationFactsUnavailable();
type Row = Record<string, unknown>;
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable();
  }
};
const str = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw unavailable();
  return value;
};
const nullableStr = (row: Row, key: string): string | null =>
  row[key] === null ? null : str(row, key);
const num = (row: Row, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw unavailable();
  return value;
};
const bool = (row: Row, key: string): boolean => {
  const value = row[key];
  if (typeof value !== "boolean") throw unavailable();
  return value;
};
const rows = (value: unknown): Row[] => {
  if (!Array.isArray(value) || !value.every((x) => x && typeof x === "object" && !Array.isArray(x)))
    throw unavailable();
  return value as Row[];
};

interface LeaseFacts {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly storeId: string;
  readonly connectionId: string;
  readonly installationId: string | null;
}

export interface LeaseDelegationReaderPorts {
  /** The step's delegation_facts (LeaseStep.delegationFacts of runLeaseStep). */
  readonly facts: (
    envelopeId: string,
    installationId: string,
    capabilityId: string,
  ) => Promise<DelegationFactsRow | null>;
  /** M5 PR-1's billing facts reader for the lease's workspace. */
  readonly billing: BillingFactsReaderPort;
  readonly environment: BillingEnvironment;
  readonly clock: () => Date;
}

export function createLeaseDelegationReader(
  ports: LeaseDelegationReaderPorts,
): AgentAuthorityReader {
  if (
    !ports ||
    typeof ports.facts !== "function" ||
    !ports.billing ||
    typeof ports.billing.read !== "function" ||
    typeof ports.clock !== "function"
  )
    throw unavailable();
  const { facts: readFacts, billing, environment, clock } = ports;
  return Object.freeze({
    async readDelegationCurrent(input: DelegationEligibilityInput): Promise<string> {
      const op: PermissionRequest = input.operation;
      const row = await readFacts(input.envelopeId, input.executorInstallationId, op.capabilityId);
      if (!row) throw unavailable();
      const leaseRow = parse(row.lease) as Row;
      if (!leaseRow || typeof leaseRow !== "object") throw unavailable();
      const lease: LeaseFacts = {
        organizationId: str(leaseRow, "organizationId"),
        workspaceId: str(leaseRow, "workspaceId"),
        kind: str(leaseRow, "kind"),
        storeId: str(leaseRow, "storeId"),
        connectionId: str(leaseRow, "connectionId"),
        installationId: nullableStr(leaseRow, "installationId"),
      };
      const O = lease.organizationId,
        W = lease.workspaceId;
      if (lease.kind !== "run" || lease.installationId !== input.executorInstallationId)
        throw unavailable();
      const envelope = parse(row.envelope) as Row;
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw unavailable();
      const hops = rows(parse(row.hops));
      const installations = new Map(
        rows(parse(row.installations)).map((r) => [str(r, "id"), r] as const),
      );
      const actors = rows(parse(row.actors));

      const humanRef = (principalId: string, membershipId: string): Core_ActorRef => ({
        kind: "human",
        principalId,
        organizationId: O,
        workspaceId: W,
        membershipId,
        installationId: null,
        mandateId: null,
      });
      const agentRef = (principalId: string, installationId: string | null): Core_ActorRef => ({
        kind: "agent",
        principalId,
        organizationId: O,
        workspaceId: W,
        membershipId: null,
        installationId,
        mandateId: null,
      });
      // One actor's current authority, from work_delegation_actor_facts, filtered (by SQL) to
      // the capabilities the kernel reads. A missing actor is a missing fact.
      const authorityOf = (
        principalId: string,
        membershipId: string | null,
        resourceFilter: (grant: Current_Grant) => boolean = () => true,
      ): CurrentActorAuthority => {
        const found = actors.find(
          (a) => a.principal_id === principalId && (a.membership_id ?? null) === membershipId,
        );
        if (!found) throw unavailable();
        const grants = found.grants;
        if (
          !Array.isArray(grants) ||
          num(found, "grant_count") !== grants.length ||
          grants.length > 1000 ||
          !grants.every((g) => validateCurrentDefinition("Grant", g))
        )
          throw unavailable();
        const revision = num(found, "policy_revision");
        const actor =
          membershipId === null
            ? agentRef(principalId, nullableStr(found, "installation_id"))
            : humanRef(principalId, membershipId);
        return {
          actor,
          principalActive: bool(found, "principal_active"),
          organizationActive: bool(found, "organization_active"),
          workspaceActive: bool(found, "workspace_active"),
          membershipActive: bool(found, "membership_active"),
          policyRevision: revision,
          grantsRevision: revision,
          grants: (grants as Current_Grant[]).filter(resourceFilter),
        };
      };
      const installed = (installationId: string): InstalledAgentAuthority => {
        const i = installations.get(installationId);
        if (!i) throw unavailable();
        const status = str(i, "status");
        if (status !== "active" && status !== "disabled" && status !== "uninstalled")
          throw unavailable();
        const storeId = str(i, "store_id");
        const installation = {
          schemaVersion: 1,
          id: installationId,
          organizationId: O,
          workspaceId: W,
          storeId,
          revision: num(i, "revision"),
          createdAt: str(i, "created_at"),
          updatedAt: str(i, "updated_at"),
          releaseRef: {
            organizationId: O,
            workspaceId: W,
            storeId: null,
            kind: "release",
            id: str(i, "release_id"),
            revision: num(i, "release_revision"),
            digest: str(i, "release_digest"),
          },
          owner: humanRef(str(i, "owner_principal_id"), str(i, "owner_membership_id")),
          status,
          configurationRef: {
            organizationId: O,
            workspaceId: W,
            storeId,
            kind: "config",
            id: installationId,
            revision: 1,
            digest: str(i, "configuration_digest"),
          },
          scope: i.scope,
          grantRefs: i.grant_refs,
          mandateRefs: [],
          dependencies: [],
          evaluationRef: null,
          provisionalExpiresAt: null,
        };
        if (!validateCurrentDefinition("AgentInstallation", installation)) throw unavailable();
        const current = authorityOf(str(i, "agent_principal_id"), null);
        if (current.actor.installationId !== installationId) throw unavailable();
        return {
          installation: installation as unknown as Current_AgentInstallation,
          current,
          owner: authorityOf(str(i, "owner_principal_id"), str(i, "owner_membership_id")),
          grantRecords: current.grants.map((payload) => ({
            organizationId: O,
            workspaceId: W,
            storeId,
            recordRevision: 1,
            payload,
          })),
        };
      };

      const requester = humanRef(
        str(envelope, "requester_principal_id"),
        str(envelope, "requester_membership_id"),
      );
      const hopFacts: DelegationHop[] = hops.map((h) => {
        const parentTaskId = str(h, "parent_task_id");
        const parentTaskResource: Current_ResourceRef = {
          organizationId: O,
          workspaceId: W,
          storeId: null,
          connectionId: null,
          kind: "task",
          id: parentTaskId,
        };
        const kind = str(h, "dispatcher_kind");
        const dispatcherPrincipal = str(h, "dispatcher_principal_id");
        const dispatcher =
          kind === "builtin_coordinator"
            ? {
                kind: "builtin_coordinator" as const,
                // The Coordinator's grants on this hop's parent task only (the 1,000 bound).
                current: authorityOf(dispatcherPrincipal, null, (g) =>
                  g.scope.resources.some((r) => r.kind === "task" && r.id === parentTaskId),
                ),
                installed: null,
              }
            : kind === "installed_agent"
              ? (() => {
                  const via = installed(str(h, "dispatcher_installation_id"));
                  return { kind: "installed_agent" as const, current: via.current, installed: via };
                })()
              : (() => {
                  throw unavailable();
                })();
        return {
          id: str(h, "id"),
          revision: num(h, "revision"),
          parentTaskId,
          parentTaskRevision: num(h, "parent_task_revision"),
          parentTaskResource,
          childTaskId: str(h, "child_task_id"),
          childTaskRevision: num(h, "child_task_revision"),
          parentEnvelopeId: str(h, "parent_envelope_id"),
          parentEnvelopeRevision: num(h, "parent_envelope_revision"),
          childEnvelopeId: str(h, "child_envelope_id"),
          childEnvelopeRevision: num(h, "child_envelope_revision"),
          dispatcher,
          recipient: agentRef(
            str(h, "recipient_principal_id"),
            str(h, "recipient_installation_id"),
          ),
          capabilityIds: h.capability_ids as DelegationHop["capabilityIds"],
          verbs: h.verbs as DelegationHop["verbs"],
          scope: h.scope as DelegationHop["scope"],
          validFrom: str(h, "valid_from"),
          expiresAt: str(h, "expires_at"),
          revokedAt: nullableStr(h, "revoked_at"),
          parentChildCount: num(h, "parent_child_count"),
        };
      });
      // Entitlement, only through entitlementFor over the workspace's billing facts. A
      // reader or parse failure throws: the step is denied, never allowed.
      const scope = { organizationId: O, workspaceId: W };
      const read = await billing.read(scope);
      const parsed = parseWorkspaceBillingFacts(read.facts, scope, environment);
      const at = clock().toISOString();
      const state = workspaceBillingState(parsed, at, environment);
      const result: DelegationAuthorityFacts = {
        envelope: {
          schemaVersion: 1,
          id: str(envelope, "id"),
          revision: num(envelope, "revision"),
          taskId: str(envelope, "task_id"),
          taskRevision: num(envelope, "task_revision"),
          organizationId: O,
          workspaceId: W,
          requester,
          authorizer: requester,
          capabilityIds:
            envelope.capability_ids as DelegationAuthorityFacts["envelope"]["capabilityIds"],
          verbs: envelope.verbs as DelegationAuthorityFacts["envelope"]["verbs"],
          scope: envelope.scope as DelegationAuthorityFacts["envelope"]["scope"],
          validFrom: str(envelope, "valid_from"),
          expiresAt: str(envelope, "expires_at"),
          revokedAt: nullableStr(envelope, "revoked_at"),
          maximumDepth: num(envelope, "maximum_depth"),
          maximumChildren: num(envelope, "maximum_children"),
        },
        origin: authorityOf(requester.principalId, requester.membershipId),
        hops: hopFacts,
        executor: installed(input.executorInstallationId),
        constraints: {
          resource: op.resource,
          accountId: op.accountId,
          providerAllowed: row.storeCurrent,
          entitlementAllowed: entitlementFor(state, op, at),
        },
      };
      return JSON.stringify(result);
    },
    async readAutomationCurrent(): Promise<string> {
      // No AutomationMandate exists in the MVP: automation never authorizes anything.
      throw unavailable();
    },
  });
}
