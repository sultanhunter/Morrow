import type {
  Core_ActorRef,
  Current_Grant,
  Current_ResourceRef,
  Current_Scope,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import {
  listingFieldPaths,
  storeResource,
  type StoreResource,
} from "@morrow/policy/store-resource";
import { canonicalJson, sha256Hex } from "../digest.js";

// The Listings specialist's fixed records (ADR-0022 items 1 and 3, with the item 3 amendment
// of 2026-10-20; mvp-architecture §7). Pure apart from hashing: the release manifest, the
// installation's configuration, its scope and exact grant set, the owner's disable grant and
// the installation document the owner confirms. The listings-authority migration seeds the
// same manifest and checks every document against the same derivation
// (morrow_work.enable_document_matches), so a drift fails closed in SQL.

/** The first-party release morrow.listings v1, exactly as the migration seeds it. */
export const listingsReleaseManifest =
  '{"capabilities":{"catalog.content.propose":["execute"],"catalog.content.publish":["propose"],"catalog.products.read":["view"]},"fields":["descriptionHtml","seo.description","seo.title","tags","title"],"id":"morrow.listings","kind":"specialist","revision":1}';
export const listingsRelease = Object.freeze({ id: "morrow.listings", revision: 1 });
/** The installation's configuration (its fields), whose digest the installation records. */
export const listingsConfiguration =
  '{"fields":["descriptionHtml","seo.description","seo.title","tags","title"]}';
export const listingsReleaseDigest = (): Promise<string> => sha256Hex(listingsReleaseManifest);
export const listingsConfigurationDigest = (): Promise<string> => sha256Hex(listingsConfiguration);

/** The installation's grant set, in capability order (catalog.content.propose first). */
export const listingsGrantSet = Object.freeze([
  Object.freeze({ capabilityId: "catalog.content.propose", verbs: Object.freeze(["execute"]) }),
  Object.freeze({ capabilityId: "catalog.content.publish", verbs: Object.freeze(["propose"]) }),
  Object.freeze({ capabilityId: "catalog.products.read", verbs: Object.freeze(["view"]) }),
] as const);
/** The fields an Enable request names on agents.installation.activate (integration fix). */
export const enableRequestFields = Object.freeze(["grant", "installationId"]);
/** The fields of the owner's agents.installation.disable grant and of a Stop request. */
export const disableFields = Object.freeze(["control", "installationId"]);

export class ListingsRecordError extends Error {
  constructor(readonly code: "LISTINGS_RECORD_INVALID") {
    super(code);
    this.name = "ListingsRecordError";
  }
}
const invalid = () => new ListingsRecordError("LISTINGS_RECORD_INVALID");

/** The installation's scope: exactly its store resource and the listing fields. */
export function listingsScope(store: StoreResource): Current_Scope {
  const scope: Current_Scope = {
    organizationId: store.organizationId,
    workspaceId: store.workspaceId,
    storeIds: [store.storeId],
    accountIds: [],
    resources: [store],
    fields: [...listingFieldPaths],
  };
  if (!validateCurrentDefinition("Scope", scope)) throw invalid();
  return scope;
}
/** The installation resource {kind installation, id I, storeId S, connectionId C}. */
export function installationResource(store: StoreResource, installationId: string) {
  const resource: Current_ResourceRef = {
    organizationId: store.organizationId,
    workspaceId: store.workspaceId,
    storeId: store.storeId,
    connectionId: store.connectionId,
    kind: "installation",
    id: installationId,
  };
  if (!validateCurrentDefinition("ResourceRef", resource)) throw invalid();
  return resource;
}
/** The owner's agents.installation.disable scope: the installation resource only. */
export function installationScope(store: StoreResource, installationId: string): Current_Scope {
  const scope: Current_Scope = {
    organizationId: store.organizationId,
    workspaceId: store.workspaceId,
    storeIds: [store.storeId],
    accountIds: [],
    resources: [installationResource(store, installationId)],
    fields: [...disableFields],
  };
  if (!validateCurrentDefinition("Scope", scope)) throw invalid();
  return scope;
}

export type DocumentPurpose = "enable" | "resume";
/** The item 3 amendment's installation document (canonical JSON is what the owner confirms). */
export interface InstallationDocument {
  readonly schemaVersion: 1;
  readonly kind: "morrow.agent_installation_document";
  readonly id: string;
  readonly purpose: DocumentPurpose;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly store: StoreResource;
  readonly installationId: string;
  readonly release: { readonly id: string; readonly revision: number; readonly digest: string };
  readonly grants: readonly {
    readonly capabilityId: string;
    readonly verbs: readonly string[];
    readonly scope: Current_Scope;
  }[];
  readonly ownerGrant: {
    readonly capabilityId: "agents.installation.disable";
    readonly verbs: readonly ["execute"];
    readonly scope: Current_Scope;
  };
  readonly actor: { readonly principalId: string; readonly membershipId: string };
  readonly createdAt: string;
  readonly expiresAt: string;
}
/** Documents expire five minutes after they are built (the amendment). */
export const documentLifetimeMs = 5 * 60 * 1000;

export async function buildInstallationDocument(input: {
  readonly id: string;
  readonly purpose: DocumentPurpose;
  readonly store: StoreResource;
  readonly installationId: string;
  readonly actor: Core_ActorRef;
  readonly createdAtMs: number;
}): Promise<{
  readonly document: InstallationDocument;
  readonly canonical: string;
  readonly digest: string;
}> {
  const { store, actor } = input;
  if (
    actor.kind !== "human" ||
    actor.membershipId === null ||
    actor.organizationId !== store.organizationId ||
    actor.workspaceId !== store.workspaceId ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.id) ||
    !validateCurrentDefinition("Id", input.installationId) ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs % 1 !== 0
  )
    throw invalid();
  const scope = listingsScope(store);
  const document: InstallationDocument = {
    schemaVersion: 1,
    kind: "morrow.agent_installation_document",
    id: input.id,
    purpose: input.purpose,
    organizationId: store.organizationId,
    workspaceId: store.workspaceId,
    store,
    installationId: input.installationId,
    release: { ...listingsRelease, digest: await listingsReleaseDigest() },
    grants: listingsGrantSet.map((g) => ({
      capabilityId: g.capabilityId,
      verbs: [...g.verbs],
      scope,
    })),
    ownerGrant: {
      capabilityId: "agents.installation.disable",
      verbs: ["execute"],
      scope: installationScope(store, input.installationId),
    },
    actor: { principalId: actor.principalId, membershipId: actor.membershipId },
    createdAt: new Date(input.createdAtMs).toISOString(),
    expiresAt: new Date(input.createdAtMs + documentLifetimeMs).toISOString(),
  };
  const canonical = canonicalJson(JSON.parse(JSON.stringify(document)));
  return Object.freeze({ document, canonical, digest: await sha256Hex(canonical) });
}

/** Parses a stored document (the server's own canonical text) back, closed. */
export function parseInstallationDocument(canonical: unknown): InstallationDocument {
  if (typeof canonical !== "string" || canonical.length > 16384) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch {
    throw invalid();
  }
  const d = value as InstallationDocument;
  if (
    !d ||
    typeof d !== "object" ||
    Array.isArray(d) ||
    Object.keys(d).sort().join(",") !== documentKeys ||
    d.schemaVersion !== 1 ||
    d.kind !== "morrow.agent_installation_document" ||
    (d.purpose !== "enable" && d.purpose !== "resume") ||
    !validateCurrentDefinition("ResourceRef", d.store) ||
    d.store.kind !== "store" ||
    d.store.organizationId !== d.organizationId ||
    d.store.workspaceId !== d.workspaceId ||
    !validateCurrentDefinition("Id", d.installationId) ||
    canonicalJson(value) !== canonical
  )
    throw invalid();
  // Everything the owner confirmed is re-derived from the store and installation: the
  // release, the exact grant set and the owner's disable grant (the migration's
  // enable_document_matches proves the same for the stored row).
  let store: StoreResource;
  try {
    store = storeResource(d.organizationId, d.workspaceId, d.store.storeId, d.store.connectionId);
  } catch {
    throw invalid();
  }
  const scope = listingsScope(store);
  const confirmed = value as Record<string, unknown>;
  const expected = {
    grants: listingsGrantSet.map((g) => ({
      capabilityId: g.capabilityId,
      verbs: [...g.verbs],
      scope,
    })),
    ownerGrant: {
      capabilityId: "agents.installation.disable",
      verbs: ["execute"],
      scope: installationScope(store, d.installationId),
    },
  };
  if (
    canonicalJson(JSON.parse(JSON.stringify(expected))) !==
      canonicalJson({ grants: confirmed.grants, ownerGrant: confirmed.ownerGrant }) ||
    d.release === null ||
    typeof d.release !== "object" ||
    d.release.id !== listingsRelease.id ||
    d.release.revision !== listingsRelease.revision ||
    typeof d.release.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(d.release.digest)
  )
    throw invalid();
  return d;
}
/**
 * The installation a resume reactivates, as the agents read returns it. Its release, store,
 * connection and scope (the scope of each of its grants, by the migration's
 * agent_installations_scope CHECK) never change after it is created.
 */
export interface PinnedInstallation {
  readonly id: string;
  readonly storeId: string;
  readonly connectionId: string;
  readonly release: { readonly id: string; readonly revision: number; readonly digest: string };
  readonly scope: unknown;
}
/**
 * The ADR-0022 item 3 amendment for a resume: the confirmed document must be exactly the
 * installation it reactivates. Its installation id, its release (id, revision and digest),
 * its store resource with the connection, and its grant set (the release's capabilities and
 * verbs, each on the installation's own scope) are compared; any difference is false. The
 * definers prove the same against the stored grants (work_agent_grant_set_current).
 */
export function resumeDocumentMatches(
  installation: PinnedInstallation,
  document: InstallationDocument,
): boolean {
  if (document.purpose !== "resume" || document.installationId !== installation.id) return false;
  try {
    const store = storeResource(
      document.organizationId,
      document.workspaceId,
      installation.storeId,
      installation.connectionId,
    );
    const scope = canonicalJson(installation.scope);
    return (
      canonicalJson(JSON.parse(JSON.stringify(document.store))) === canonicalJson(store) &&
      canonicalJson(JSON.parse(JSON.stringify(document.release))) ===
        canonicalJson({ ...installation.release }) &&
      canonicalJson(JSON.parse(JSON.stringify(listingsScope(store)))) === scope &&
      document.grants.length === listingsGrantSet.length &&
      document.grants.every(
        (g, i) =>
          g.capabilityId === listingsGrantSet[i]!.capabilityId &&
          canonicalJson([...g.verbs]) === canonicalJson([...listingsGrantSet[i]!.verbs]) &&
          canonicalJson(JSON.parse(JSON.stringify(g.scope))) === scope,
      )
    );
  } catch {
    return false;
  }
}
const documentKeys = [
  "actor",
  "createdAt",
  "expiresAt",
  "grants",
  "id",
  "installationId",
  "kind",
  "organizationId",
  "ownerGrant",
  "purpose",
  "release",
  "schemaVersion",
  "store",
  "workspaceId",
].join(",");

/**
 * The installation's three grant payloads (current Grant), issued by the owner to the
 * installation's agent principal, valid from database time, no expiry. Ids are fresh.
 */
export function installationGrants(input: {
  readonly store: StoreResource;
  readonly installationId: string;
  readonly agentPrincipalId: string;
  readonly issuer: Core_ActorRef;
  readonly validFrom: string;
  readonly policyRevision: number;
  readonly ids: readonly string[];
}): readonly Current_Grant[] {
  if (input.ids.length !== listingsGrantSet.length) throw invalid();
  const principal: Core_ActorRef = {
    kind: "agent",
    principalId: input.agentPrincipalId,
    organizationId: input.store.organizationId,
    workspaceId: input.store.workspaceId,
    membershipId: null,
    installationId: input.installationId,
    mandateId: null,
  };
  const scope = listingsScope(input.store);
  return listingsGrantSet.map((g, i) => {
    const grant = {
      id: input.ids[i]!,
      principal,
      capabilityId: g.capabilityId,
      verbs: [...g.verbs],
      scope,
      issuedBy: input.issuer,
      validFrom: input.validFrom,
      expiresAt: null,
      revokedAt: null,
      policyRevision: input.policyRevision,
    };
    if (!validateCurrentDefinition("Grant", grant)) throw invalid();
    return grant as Current_Grant;
  });
}

/** The owner's agents.installation.disable {execute} on the installation, from morrow.agents. */
export function ownerDisableGrant(input: {
  readonly store: StoreResource;
  readonly installationId: string;
  readonly owner: Core_ActorRef;
  readonly validFrom: string;
  readonly policyRevision: number;
  readonly id: string;
}): Current_Grant {
  const grant = {
    id: input.id,
    principal: input.owner,
    capabilityId: "agents.installation.disable",
    verbs: ["execute"],
    scope: installationScope(input.store, input.installationId),
    issuedBy: {
      kind: "service",
      principalId: "morrow.agents",
      organizationId: input.store.organizationId,
      workspaceId: input.store.workspaceId,
      membershipId: null,
      installationId: null,
      mandateId: null,
    },
    validFrom: input.validFrom,
    expiresAt: null,
    revokedAt: null,
    policyRevision: input.policyRevision,
  };
  if (!validateCurrentDefinition("Grant", grant)) throw invalid();
  return grant as Current_Grant;
}

export { storeResource, type StoreResource };
