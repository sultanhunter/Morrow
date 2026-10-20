// The Shopify link issuer and the connections read (M2 PR-2; P09.T02a; ADR-0022 items 3-5;
// mvp-architecture §2 step 5). Private server composition: the api's managed workspace
// handler calls these after its request guard, on the linking login's pool.
//
// Issuer (in POST /workspace/:ws/store-links/preview, before the unchanged lookup):
//   1. the linking login reads the actor and its grants (session and workspace from the
//      guard; no client value);
//   2. the injected connection kernel (the TypeScript human kernel, wired by the api from
//      @morrow/policy) decides governance.connection.connect administer on the workspace
//      resource with the connect input fields, and picks the grant;
//   3. issue_shopify_link_handoff rechecks everything under locks (the continuation is the
//      handoff nonce, which is the digest of the fragment token the browser posted; the
//      actor must be the organization's owner, to whom the store-link template goes,
//      ADR-0022 item 3) and writes the P05.T03a review and handoff. The SQL recheck is the
//      authority; the kernel is the extra in-code check.
// issued, exists and not_found (no continuation: a P05.T03a controlled-fixture handoff)
// continue to the lookup; a kernel denial or denied is linking_not_found; route_not_ready
// is billing_route_required, reachable only after the session and grant passed.
//
// Connections (GET /workspace/:ws/connections): any session-eligible member reads the
// workspace's installations; the install link is offered only to the organization's owner
// (the only actor the issuer admits, ADR-0022 item 3) when the kernel allows
// connect/administer, an active app invites the workspace, the route is morrow_direct and
// no store is linked (WorkspaceConnections@1, validated before it is sent). A reader with
// more than 1000 grants gets 503, never a signed-out answer.
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { standaloneJson, type GuardedStandaloneRequest } from "./standalone-request-guard.js";
import type { StandaloneWorkspaceSqlPool } from "./standalone-workspace-bootstrap.js";
import {
  createControlledWorkspaceStoreLinking,
  type LinkingAuthorityFacts,
  type WorkspaceConnectionFacts,
} from "./workspace-store-linking-control.js";

export type { LinkingAuthorityFacts } from "./workspace-store-linking-control.js";
export interface ConnectionKernelDecision {
  readonly allowed: boolean;
  /** The grant the decision rests on, when allowed. */
  readonly grantId: string | null;
}
/** The api's kernel port: governance.connection.connect administer for these facts. */
export type ConnectionKernel = (
  facts: Readonly<LinkingAuthorityFacts>,
) => Promise<ConnectionKernelDecision>;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
async function decide(
  kernel: ConnectionKernel,
  facts: Readonly<LinkingAuthorityFacts>,
): Promise<ConnectionKernelDecision> {
  try {
    const d = await kernel(facts);
    if (d && d.allowed === true && typeof d.grantId === "string" && idPattern.test(d.grantId))
      return Object.freeze({ allowed: true, grantId: d.grantId });
  } catch {
    // A kernel failure is a denial.
  }
  return Object.freeze({ allowed: false, grantId: null });
}

export type IssuerVerdict = "proceed" | Response;
/**
 * Runs the issuer for one preview. Returns "proceed" for the unchanged lookup, or the
 * final response. Throws (the caller answers 503) on an unavailable database or an
 * unknown commit.
 */
export async function runShopifyLinkIssuer(
  pool: StandaloneWorkspaceSqlPool,
  now: () => number,
  kernel: ConnectionKernel,
  context: Readonly<GuardedStandaloneRequest>,
): Promise<IssuerVerdict> {
  if (context.nonceDigest === null || context.commandId === null) return "proceed";
  const service = createControlledWorkspaceStoreLinking({ pool, now });
  const selector = JSON.stringify({
    sessionDigest: context.sessionDigest,
    workspaceId: context.workspaceId,
  });
  const facts = await context.wait(service.authority(selector, context.control));
  context.check();
  if (!facts) return standaloneJson(404, { code: "linking_not_found" });
  const decision = await decide(kernel, facts);
  context.check();
  if (!decision.allowed || decision.grantId === null)
    return standaloneJson(404, { code: "linking_not_found" });
  const outcome = await context.wait(
    service.issue(
      JSON.stringify({
        sessionDigest: context.sessionDigest,
        workspaceId: context.workspaceId,
        nonceDigest: context.nonceDigest,
        commandId: context.commandId,
        grantId: decision.grantId,
      }),
      context.control,
    ),
  );
  context.check();
  if (outcome === "route_not_ready") return standaloneJson(409, { code: "billing_route_required" });
  if (outcome === "issued" || outcome === "exists" || outcome === "not_found") return "proceed";
  return standaloneJson(404, { code: "linking_not_found" });
}

type InstallLinkReason =
  | "offered"
  | "linked"
  | "not_permitted"
  | "not_registered"
  | "route_not_ready";
function offer(
  connections: Readonly<WorkspaceConnectionFacts>,
  allowed: boolean,
): { offered: boolean; url: string | null; reason: InstallLinkReason } {
  if (connections.linked) return { offered: false, url: null, reason: "linked" };
  if (!allowed || !connections.owner) return { offered: false, url: null, reason: "not_permitted" };
  if (!connections.appRegistered || connections.installUrl === null)
    return { offered: false, url: null, reason: "not_registered" };
  if (connections.route !== "morrow_direct")
    return { offered: false, url: null, reason: "route_not_ready" };
  return { offered: true, url: connections.installUrl, reason: "offered" };
}

/** GET /workspace/:ws/connections: WorkspaceConnections@1, or a fixed refusal. */
export async function executeWorkspaceConnections(
  pool: StandaloneWorkspaceSqlPool,
  now: () => number,
  kernel: ConnectionKernel | undefined,
  context: Readonly<GuardedStandaloneRequest>,
): Promise<Response> {
  try {
    const service = createControlledWorkspaceStoreLinking({ pool, now });
    const read = await context.wait(
      service.connections(
        JSON.stringify({ sessionDigest: context.sessionDigest, workspaceId: context.workspaceId }),
        context.control,
      ),
    );
    context.check();
    if (!read) return standaloneJson(401, { code: "authentication_required" });
    // Without a configured kernel no install link is ever offered (fail closed).
    const allowed = kernel ? (await decide(kernel, read.facts)).allowed : false;
    context.check();
    const body = {
      schemaVersion: 1,
      installations: read.connections.installations.slice(0, 51),
      installLink: offer(read.connections, allowed),
    };
    if (body.installations.length > 50 || !validateCurrentDefinition("WorkspaceConnections", body))
      return standaloneJson(503, { code: "unavailable" });
    for (const installation of body.installations as {
      workspaceId?: unknown;
      organizationId?: unknown;
    }[])
      if (
        installation.workspaceId !== read.facts.workspaceId ||
        installation.organizationId !== read.facts.organizationId
      )
        return standaloneJson(503, { code: "unavailable" });
    return standaloneJson(200, body);
  } catch {
    return standaloneJson(503, { code: "unavailable" });
  }
}
