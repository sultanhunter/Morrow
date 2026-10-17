// Local workerd fixture only. Never deployed or imported by an application.
import {
  createWorkspaceStoreLinks,
  workspaceStoreLinkingSql as sql,
  WorkspaceStoreLinkingError,
} from "../../packages/identity/src/workspace-store-linking";
import { createHumanPolicyService } from "../../packages/policy/src/index";

const input = {
  handoffId: "handoff_fixture",
  commandId: "command_fixture",
  requestDigest: "a".repeat(64),
  sessionDigest: "b".repeat(64),
  nonceDigest: "c".repeat(64),
  organizationId: "org_fixture",
  workspaceId: "workspace_fixture",
  installationId: "installation_fixture",
  purpose: "workspace_first",
  expectedPolicyRevision: 7,
  expectedOwnershipRevision: 3,
};
const role = {
  role: "morrow_identity_linking",
  login: "morrow_identity_linking",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
};
const applied = {
  outcome: "applied",
  link_id: "link_fixture",
  ownership_revision: "4",
  policy_revision: "8",
  audit_id: "audit_fixture",
};
interface Options {
  role?: Record<string, unknown>;
  row?: Record<string, unknown>;
  failAt?: string;
  releaseFails?: boolean;
}
function pool(options: Options = {}) {
  const queries: { text: string; values?: readonly string[] }[] = [];
  let connections = 0;
  return {
    queries,
    get connections() {
      return connections;
    },
    async connect() {
      connections++;
      return {
        async query(text: string, values?: readonly string[]) {
          queries.push(values ? { text, values } : { text });
          if (text === options.failAt) throw Error("PRIVATE_FIXTURE_ERROR");
          if (text === sql.role) return { rows: [options.role ?? role] };
          if (text === sql.apply) return { rows: [options.row ?? applied] };
          return { rows: [] };
        },
        release() {
          if (options.releaseFails) throw Error("PRIVATE_FIXTURE_RELEASE");
        },
      };
    },
  };
}
export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/workspace-store-linking")
      return new Response(null, { status: 404 });
    const checks: { name: string; passed: boolean }[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    const encoded = JSON.stringify(input);
    const normal = pool(),
      service = createWorkspaceStoreLinks(normal);
    const result = await service.apply(encoded);
    check(
      "fixed_parameterized_link_result",
      result.outcome === "applied" &&
        result.ownershipRevision === 4 &&
        result.policyRevision === 8 &&
        Object.isFrozen(result),
    );
    const operation = normal.queries.find((q) => q.text === sql.apply);
    check(
      "all_eleven_scalars_bound_once",
      normal.queries.filter((q) => q.text === sql.apply).length === 1 &&
        operation?.values?.join(",") ===
          [...Object.values(input).slice(0, 9), "7", "3"].join(",") &&
        Object.isFrozen(operation.values),
    );
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++;
          throw Error("FIXTURE_TRAP");
        },
        getPrototypeOf() {
          traps++;
          throw Error("FIXTURE_TRAP");
        },
        ownKeys() {
          traps++;
          throw Error("FIXTURE_TRAP");
        },
        getOwnPropertyDescriptor() {
          traps++;
          throw Error("FIXTURE_TRAP");
        },
      },
    );
    const accessor = {
      get handoffId() {
        traps++;
        throw Error("FIXTURE_GETTER");
      },
    };
    for (const [name, value] of [
      ["proxy_denied_without_traps", hostile],
      ["accessor_denied_without_getters", accessor],
      ["raw_object_denied", input],
      ["malformed_json_denied", "{bad"],
      ["oversized_json_denied", " ".repeat(8193)],
      ["unknown_authority_field_denied", JSON.stringify({ ...input, approved: true })],
    ] as const) {
      const p = pool();
      let denied = false;
      try {
        await createWorkspaceStoreLinks(p).apply(value);
      } catch (error) {
        denied =
          error instanceof WorkspaceStoreLinkingError &&
          error.code === "WORKSPACE_LINKING_INPUT_INVALID" &&
          error.commandId === null;
      }
      check(name, denied && traps === 0 && p.connections === 0);
    }
    for (const [name, options, expected] of [
      [
        "ordinary_api_role_denied",
        { role: { ...role, role: "morrow_api" } },
        "WORKSPACE_LINKING_UNAVAILABLE",
      ],
      [
        "role_membership_denied",
        { role: { ...role, role_member: true } },
        "WORKSPACE_LINKING_UNAVAILABLE",
      ],
      [
        "inheriting_role_denied",
        { role: { ...role, rolinherit: true } },
        "WORKSPACE_LINKING_UNAVAILABLE",
      ],
      [
        "ownership_reply_drift_denied",
        { row: { ...applied, ownership_revision: "5" } },
        "WORKSPACE_LINKING_UNAVAILABLE",
      ],
      [
        "policy_reply_drift_denied",
        { row: { ...applied, policy_revision: "9" } },
        "WORKSPACE_LINKING_UNAVAILABLE",
      ],
      ["commit_loss_uncertain", { failAt: sql.commit }, "WORKSPACE_LINKING_UNCERTAIN"],
      ["release_loss_uncertain", { releaseFails: true }, "WORKSPACE_LINKING_UNCERTAIN"],
    ] as const) {
      const p = pool(options);
      let denied = false;
      try {
        await createWorkspaceStoreLinks(p).apply(encoded);
      } catch (error) {
        denied =
          error instanceof WorkspaceStoreLinkingError &&
          error.code === expected &&
          error.message === expected &&
          !JSON.stringify(error).includes(input.sessionDigest);
      }
      check(name, denied && p.queries.filter((q) => q.text === sql.apply).length <= 1);
    }
    const actor = {
      kind: "human" as const,
      principalId: "human_fixture",
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      membershipId: "membership_fixture",
      installationId: null,
      mandateId: null,
    };
    const resource = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      storeId: null,
      connectionId: null,
      kind: "workspace" as const,
      id: input.workspaceId,
    };
    const grant = {
      id: "grant_fixture",
      principal: actor,
      capabilityId: "governance.connection.connect",
      verbs: ["administer" as const],
      scope: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        storeIds: [],
        accountIds: [],
        resources: [resource],
        fields: ["providerId", "installationProof", "scope"],
      },
      issuedBy: actor,
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      policyRevision: 7,
    };
    const facts = {
      actor,
      policyRevision: 7,
      grantsRevision: 7,
      resource,
      accountId: null,
      grants: [grant],
      principalActive: true,
      organizationActive: true,
      workspaceActive: true,
      membershipActive: true,
      sessionCurrent: true,
      providerAllowed: true,
      entitlementAllowed: true,
    };
    const policyRequest = {
      capabilityId: grant.capabilityId,
      verb: "administer",
      resource,
      accountId: null,
      fields: ["providerId", "installationProof", "scope"],
    };
    const policy = createHumanPolicyService(
      {
        async readCurrent() {
          return facts;
        },
      },
      () => new Date("2026-10-15T00:00:00.000Z"),
    );
    const allowed = await policy.decide(policyRequest);
    check(
      "connect_administer_requires_exact_approval",
      allowed.decision.allowed &&
        allowed.obligations.includes("exact_approval") &&
        allowed.obligations.includes("recheck_at_dispatch"),
    );
    const field = await policy.decide({
      ...policyRequest,
      fields: [...policyRequest.fields, "vaultSecret"],
    });
    check(
      "field_expansion_denied",
      !field.decision.allowed && field.decision.reason === "field_denied",
    );
    const noGrant = createHumanPolicyService(
      {
        async readCurrent() {
          return { ...facts, grants: [] };
        },
      },
      () => new Date("2026-10-15T00:00:00.000Z"),
    );
    const notAuthority = await noGrant.decide(policyRequest);
    check(
      "handoff_or_review_reference_cannot_replace_grant",
      !notAuthority.decision.allowed &&
        notAuthority.decision.reason === "capability_denied" &&
        notAuthority.obligations.length === 0,
    );
    let dynamicDenied = false;
    try {
      new Function("return 1")();
    } catch {
      dynamicDenied = true;
    }
    check("dynamic_code_generation_denied", dynamicDenied);
    return Response.json({ checks });
  },
};
