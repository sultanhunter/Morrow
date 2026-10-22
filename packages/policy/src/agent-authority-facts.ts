import type {
  Core_ActorRef,
  Core_AutomationMandate,
  Core_PolicyDecision,
  CapabilityId,
  Current_AgentInstallation,
  Current_Grant,
  Current_ResourceRef,
  Current_Scope,
} from "@morrow/contracts";
import type { PermissionRequest, PermissionVerb } from "./index";

// Internal closed facts, not new frozen-v1 wire schemas or authenticated proofs.
// All readers are trusted server ports; this increment supplies no live reader.
export interface CurrentActorAuthority {
  readonly actor: Core_ActorRef;
  readonly principalActive: boolean;
  readonly organizationActive: boolean;
  readonly workspaceActive: boolean;
  // Required for human authority only. Agents have membershipId:null and are
  // checked through current principal, installation and human owner authority.
  readonly membershipActive: boolean;
  readonly policyRevision: number;
  readonly grantsRevision: number;
  readonly grants: readonly Current_Grant[];
}
export interface ResolvedGrantRecord {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string | null;
  readonly recordRevision: number;
  readonly payload: Current_Grant;
}
export interface ResolvedMandateRecord {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string | null;
  readonly recordRevision: number;
  readonly payload: Core_AutomationMandate;
}
export interface InstalledAgentAuthority {
  readonly installation: Current_AgentInstallation;
  readonly current: CurrentActorAuthority;
  readonly owner: CurrentActorAuthority;
  readonly grantRecords: readonly ResolvedGrantRecord[];
}
export type DispatcherAuthority =
  | {
      readonly kind: "builtin_coordinator";
      readonly current: CurrentActorAuthority;
      readonly installed: null;
    }
  | {
      readonly kind: "installed_agent";
      readonly current: CurrentActorAuthority;
      readonly installed: InstalledAgentAuthority;
    };
export interface PrincipalWorkEnvelope {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly requester: Core_ActorRef;
  readonly authorizer: Core_ActorRef;
  readonly capabilityIds: readonly CapabilityId[];
  readonly verbs: readonly PermissionVerb[];
  readonly scope: Current_Scope;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly maximumDepth: number;
  readonly maximumChildren: number;
}
export interface DelegationHop {
  readonly id: string;
  readonly revision: number;
  readonly parentTaskId: string;
  readonly parentTaskRevision: number;
  readonly parentTaskResource: Current_ResourceRef;
  readonly childTaskId: string;
  readonly childTaskRevision: number;
  readonly parentEnvelopeId: string;
  readonly parentEnvelopeRevision: number;
  readonly childEnvelopeId: string;
  readonly childEnvelopeRevision: number;
  readonly dispatcher: DispatcherAuthority;
  readonly recipient: Core_ActorRef;
  readonly capabilityIds: readonly CapabilityId[];
  readonly verbs: readonly PermissionVerb[];
  readonly scope: Current_Scope;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly parentChildCount: number;
}
export interface CurrentOperationConstraints {
  readonly resource: Current_ResourceRef;
  readonly accountId: string | null;
  readonly providerAllowed: boolean;
  readonly entitlementAllowed: boolean;
}
export interface DelegationAuthorityFacts {
  readonly envelope: PrincipalWorkEnvelope;
  readonly origin: CurrentActorAuthority;
  readonly hops: readonly DelegationHop[];
  readonly executor: InstalledAgentAuthority;
  readonly constraints: CurrentOperationConstraints;
}
export interface AutomationAuthorityFacts {
  readonly mandate: ResolvedMandateRecord;
  readonly executor: InstalledAgentAuthority;
  readonly constraints: CurrentOperationConstraints;
}
export interface DelegationEligibilityInput {
  readonly envelopeId: string;
  readonly executorInstallationId: string;
  readonly operation: PermissionRequest;
}
export interface AutomationEligibilityInput {
  readonly mandateId: string;
  readonly executorInstallationId: string;
  readonly operation: PermissionRequest;
}
export interface AgentAuthorityReader {
  // Return primitive JSON text encoding the corresponding facts. No object,
  // proxy or accessor-bearing value crosses the runtime validation boundary.
  readDelegationCurrent(input: DelegationEligibilityInput): Promise<string>;
  readAutomationCurrent(input: AutomationEligibilityInput): Promise<string>;
}
export type AgentExecutionObligation =
  | "recheck_at_dispatch"
  | "exact_approval"
  | "budget_reservation"
  | "provider_effect_verification"
  | "atomic_delegation_admission"
  | "qualified_dispatch";
export interface AgentAuthorityLineage {
  readonly requester: Core_ActorRef;
  readonly authorizer: Core_ActorRef;
  readonly dispatchers: readonly Core_ActorRef[];
  readonly executor: Core_ActorRef;
  readonly envelopeId: string | null;
  readonly mandateId: string | null;
}
export interface AgentPermissionResult {
  readonly decision: Core_PolicyDecision;
  readonly obligations: readonly AgentExecutionObligation[];
  // No denial exposes actor IDs from malformed or foreign reader facts.
  readonly lineage: AgentAuthorityLineage | null;
}
