// morrow-<env>-connector (P04.T02a D8). A fail-closed placeholder until ADR-0008
// (connector runtime, Proposed) is approved: no Shopify secret, route or
// provider call exists, and it binds only MORROW_ENVIRONMENT.

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export default {
  fetch(request: Request): Response {
    let healthz = false;
    try {
      healthz = request.method === "GET" && new URL(request.url).pathname === "/healthz";
    } catch {
      healthz = false;
    }
    return healthz
      ? new Response('{"schemaVersion":1,"service":"connector","mode":"placeholder"}', {
          status: 200,
          headers,
        })
      : new Response('{"code":"connector_unavailable"}', { status: 503, headers });
  },
};
