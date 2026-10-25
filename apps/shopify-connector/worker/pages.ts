// The connector's fixed pages (M2 PR-2). Plain HTML with no script, style, form, image or
// frame: CSP default-src 'none', never framed, never cached, no referrer. A page names at
// most the shop's verified *.myshopify.com domain (escaped) and one link to the api's
// connections screen of the registry's invited workspace; no other workspace data.
const securityHeaders: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});
export const connectorPageHeaders = securityHeaders;
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type ConnectorPage =
  | "invalid"
  | "connected"
  | "installed_unlinked"
  | "unavailable"
  | "expired"
  | "not_development"
  | "scopes_mismatch"
  | "uncertain"
  | "limited"
  | "ineligible"
  | "reconnect";
const pages: Readonly<Record<ConnectorPage, readonly [number, string, string]>> = Object.freeze({
  invalid: [
    403,
    "Link not valid",
    "This link is not valid. Open the app again from your Shopify admin.",
  ],
  connected: [200, "Connected", "This store is connected to Morrow."],
  installed_unlinked: [
    200,
    "Finish connecting",
    "This store is installed. Sign in to Morrow, then open the app again from your Shopify admin to finish connecting it.",
  ],
  unavailable: [
    503,
    "Unavailable",
    "Morrow can't connect this store right now. Try again in a few minutes.",
  ],
  expired: [
    400,
    "Step expired",
    "This install step expired. Open the app again from your Shopify admin.",
  ],
  not_development: [
    403,
    "Development stores only",
    "Morrow's beta works only with Shopify development stores. Nothing was saved. Uninstall the app from this store's admin.",
  ],
  scopes_mismatch: [
    403,
    "Permissions differ",
    "Shopify granted different permissions than Morrow asked for. Nothing was saved. Uninstall the app, then install it again from the link Morrow gave you.",
  ],
  uncertain: [
    503,
    "Not confirmed",
    "We couldn't confirm the connection. Open the app again from your Shopify admin to finish.",
  ],
  limited: [
    429,
    "Too many attempts",
    "Too many connection attempts. Wait a few minutes, then open the app again.",
  ],
  ineligible: [409, "Not available", "This store can't be connected right now."],
  // v1 PR 5: a live connection that lacks a permission Morrow asks for, or whose access
  // Shopify no longer accepts. Opening the app again from Shopify reconnects it. Reconnecting
  // never restarts an agent Morrow paused for it, and no screen restarts one in this build
  // (ADR-0024 item 2's resume is a later PR), so the page promises no self-service resume
  // (PR 5 review finding F4, after integration with main).
  reconnect: [
    200,
    "Reconnect",
    "Morrow needs this store's permissions again. Open the app again from your Shopify admin to reconnect it. Agents Morrow paused for this stay paused after you reconnect. Restarting them isn't available in Morrow yet, so contact Morrow support if you need one running again.",
  ],
});

export function connectorPage(
  page: ConnectorPage,
  options: { shop?: string; link?: string; setCookie?: string } = {},
): Response {
  const [status, title, message] = pages[page];
  const shop =
    options.shop && /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(options.shop)
      ? `<p>${escape(options.shop)}</p>`
      : "";
  const link = options.link ? `<p><a href="${escape(options.link)}">Open Morrow</a></p>` : "";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Morrow - ${escape(title)}</title></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${shop}${link}</main></body></html>`;
  const headers = new Headers(securityHeaders);
  if (options.setCookie) headers.append("set-cookie", options.setCookie);
  return new Response(body, { status, headers });
}
export function connectorJson(status: number, value: unknown, setCookie?: string): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(JSON.stringify(value), { status, headers });
}
/** The connections screen of one workspace on the api origin, optionally with the fragment. */
export function connectionsUrl(apiOrigin: string, workspaceId: string, handoff?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspaceId))
    throw Error("CONNECTOR_WORKSPACE_INVALID");
  const base = `${apiOrigin}/w/${encodeURIComponent(workspaceId)}/connections`;
  return handoff === undefined ? base : `${base}#handoff=${handoff}`;
}
