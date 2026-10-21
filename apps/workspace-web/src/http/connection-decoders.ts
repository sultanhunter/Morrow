// Connection reply decoders (M2 PR-2): GET /workspace/:ws/connections (WorkspaceConnections@1)
// and the P05.T03b store-link routes behind the P09.T02a issuer (preview, apply, status).
// Hand-written like the identity decoders: no eval or schema compilation, unknown
// properties ignored, every (status, body) pair mapped to a fixed outcome and fixed copy.
// No server text, token or credential reaches a view model.
import type {
  ConnectionsView,
  InstallLinkReason,
  InstallLinkView,
  Outcome,
  StoreConnectionView,
  StoreLinkPreviewView,
  StoreLinkResultView,
} from "@morrow/workspace-ui";
import { isId, type Reply } from "./client";
import { failureOutcome, record } from "./identity-decoders";

const unavailable = (offline = false) => ({ kind: "unavailable", offline }) as const;
const uncertain = { kind: "uncertain" } as const;
const unauthenticated = { kind: "unauthenticated" } as const;
const denied = { kind: "denied", message: "", reference: null } as const;
const notFound = { kind: "not_found" } as const;
/** The guard's and the routes' fixed `{code}` bodies. */
const coded = (body: unknown, code: string) =>
  record(body) && body.code === code && Object.keys(body).length === 1;
const outcomeBody = (body: unknown, outcome: string) =>
  record(body) && body.schemaVersion === 1 && body.outcome === outcome;

// StoreInstallation@1 (v1 core): its shop domain pattern, and the install link of
// InstallLinkOffer (https on Shopify's admin or a myshopify host).
const shopDomainPattern = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export const installUrlPattern =
  /^https:\/\/(admin\.shopify\.com|[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com)\/[!-~]+$/;
/** The api guard's CSRF value: a 32-byte base64url secret, canonical tail. */
export const csrfTokenPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const statusPattern = /^[a-z][a-z_]{0,39}$/;
const scopePattern = /^[a-z][a-z_]{0,63}$/;
const reasons: readonly InstallLinkReason[] = [
  "offered",
  "linked",
  "not_permitted",
  "not_registered",
  "route_not_ready",
];
const utc = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));

function decodeInstallation(value: unknown, workspaceId: string): StoreConnectionView | null {
  if (!record(value) || value.schemaVersion !== 1) return null;
  const { id, workspaceId: ws, storeId, connectionId, shopDomain, status, grantedScopes } = value;
  if (!isId(id) || ws !== workspaceId || !isId(connectionId)) return null;
  if (storeId !== null && !isId(storeId)) return null;
  if (
    typeof shopDomain !== "string" ||
    shopDomain.length > 255 ||
    !shopDomainPattern.test(shopDomain)
  )
    return null;
  if (typeof status !== "string" || !statusPattern.test(status)) return null;
  if (
    !Array.isArray(grantedScopes) ||
    grantedScopes.length > 16 ||
    !grantedScopes.every((s) => typeof s === "string" && scopePattern.test(s))
  )
    return null;
  if (!utc(value.updatedAt)) return null;
  return {
    installationId: id,
    connectionId,
    storeId,
    shopDomain,
    status,
    grantedScopes: [...(grantedScopes as string[])],
    updatedAt: value.updatedAt,
  };
}
function decodeOffer(value: unknown): InstallLinkView | null {
  if (!record(value)) return null;
  const { offered, url, reason } = value;
  if (offered === true)
    return reason === "offered" &&
      typeof url === "string" &&
      url.length <= 2048 &&
      installUrlPattern.test(url)
      ? { offered: true, url, reason: "offered" }
      : null;
  if (offered !== false || url !== null) return null;
  if (typeof reason !== "string" || reason === "offered" || !reasons.includes(reason as never))
    return null;
  return { offered: false, url: null, reason: reason as InstallLinkReason };
}
/** The 200 body: at most 50 installations of this workspace, distinct connections. */
export function decodeConnectionsBody(body: unknown, workspaceId: string): ConnectionsView | null {
  if (!record(body) || body.schemaVersion !== 1) return null;
  const { installations, installLink } = body;
  if (!Array.isArray(installations) || installations.length > 50) return null;
  const decoded: StoreConnectionView[] = [];
  for (const entry of installations as readonly unknown[]) {
    const installation = decodeInstallation(entry, workspaceId);
    if (!installation) return null;
    decoded.push(installation);
  }
  if (new Set(decoded.map((i) => i.connectionId)).size !== decoded.length) return null;
  const offer = decodeOffer(installLink);
  return offer ? { installations: decoded, installLink: offer } : null;
}

/** GET /workspace/:ws/connections: a read; a non-decoding reply is unavailable. */
export function decodeConnections(reply: Reply, workspaceId: string): Outcome<ConnectionsView> {
  if (reply.kind !== "response") return failureOutcome(reply, "read");
  const { status, body } = reply;
  if (status === 200) {
    const value = decodeConnectionsBody(body, workspaceId);
    return value ? { kind: "ok", value, replayed: false } : unavailable();
  }
  if (status === 401) return unauthenticated;
  if (status === 403) return denied;
  if (status === 404) return notFound;
  return unavailable();
}

// The guard's refusals before anything ran (P05.T03b): a 400 or 405 is a request this
// adapter should never send; a 403 is a refused origin, header or CSRF value.
function guardOutcome(status: number, body: unknown): Outcome<never> | null {
  if (status === 401) return unauthenticated;
  if ((status === 400 || status === 405) && coded(body, "request_denied"))
    return { kind: "invalid", field: null };
  if (status === 403 && coded(body, "request_denied")) return denied;
  // linking_not_found, or the guard's own 404: nothing ran either way.
  if (status === 404) return notFound;
  return null;
}

/**
 * POST /workspace/:ws/store-links/preview. The issuer and the lookup are replay-safe for
 * the same key and continuation, so a 503 or a lost reply is sent again with that key.
 * The only 409 is billing_route_required (no fixed morrow_direct route).
 */
export function decodeStoreLinkPreview(reply: Reply): Outcome<StoreLinkPreviewView> {
  if (reply.kind !== "response") return failureOutcome(reply, "command");
  const { status, body } = reply;
  if (status === 200) {
    if (
      record(body) &&
      body.schemaVersion === 1 &&
      record(body.link) &&
      isId(body.link.installationId) &&
      typeof body.csrfToken === "string" &&
      csrfTokenPattern.test(body.csrfToken)
    )
      return {
        kind: "ok",
        value: { installationId: body.link.installationId, csrfToken: body.csrfToken },
        replayed: false,
      };
    return uncertain;
  }
  const guarded = guardOutcome(status, body);
  if (guarded) return guarded;
  if (status === 409 && coded(body, "billing_route_required"))
    return { kind: "conflict", recheck: false, message: "" };
  if (status === 503 && coded(body, "unavailable")) return unavailable();
  return uncertain;
}

/**
 * POST /workspace/:ws/store-links (apply) and /store-links/status. A recorded decision is
 * ok (applied, or denied with nothing changed); apply's 503 outcome_unknown and any reply
 * that can't be decoded stay uncertain until status answers. A status 404 means no
 * decision was recorded for this key.
 */
export function decodeStoreLinkResult(reply: Reply): Outcome<StoreLinkResultView> {
  if (reply.kind !== "response") return failureOutcome(reply, "command");
  const { status, body } = reply;
  if (status === 200 && outcomeBody(body, "applied")) {
    const b = body as Readonly<Record<string, unknown>>;
    return isId(b.linkId) && isId(b.auditId)
      ? { kind: "ok", value: { outcome: "applied" }, replayed: false }
      : uncertain;
  }
  if ((status === 200 || status === 403) && outcomeBody(body, "denied"))
    return { kind: "ok", value: { outcome: "denied" }, replayed: false };
  const guarded = guardOutcome(status, body);
  if (guarded) return guarded;
  if (status === 409 && outcomeBody(body, "conflict"))
    return { kind: "conflict", recheck: false, message: "" };
  // The guard answers 503 {code:unavailable} only before the link ran.
  if (status === 503 && coded(body, "unavailable")) return unavailable();
  return uncertain;
}
