// The P06.T01a-AC21 request guard matrix (the P05.T01x-AC28 shape). Shared by the
// Node tests and the workerd laboratory; plain data only, so it can cross a
// Miniflare dispatch as JSON. No case may open a SQL connection.
export const workGuardOrigin = "https://work.morrow.test";
// base64url of 32 bytes of 0x07: a canonical, synthetic session secret.
export const workGuardSecret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const key = "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b";
const goal = JSON.stringify({
  objective: "Guarded",
  storeIds: [],
  successCriteria: [{ description: "d", verificationCapabilityId: null, evidenceRequired: false }],
});
const post = (overrides = {}) => ({
  method: "POST",
  path: "/workspace/ws_w/work/goals",
  headers: {
    Cookie: "__Host-morrow_session=" + workGuardSecret,
    Origin: workGuardOrigin,
    "Content-Type": "application/json",
    "X-Morrow-Request": "1",
    "Idempotency-Key": key,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...overrides.headers,
  },
  body: overrides.body ?? goal,
  bytes: overrides.bytes,
});
const get = (overrides = {}) => ({
  method: "GET",
  path: overrides.path ?? "/workspace/ws_w/work/goals",
  headers: {
    Cookie: "__Host-morrow_session=" + workGuardSecret,
    "Sec-Fetch-Site": "same-origin",
    ...overrides.headers,
  },
});
const with_ = (base, status, extra = {}) => ({ ...base, status, ...extra });
const goalWith = (change) => JSON.stringify({ ...JSON.parse(goal), ...change });

export const workGuardCases = Object.freeze([
  // 403: origin and fetch metadata, custom header, content type.
  ["missing_origin", with_(post({ headers: { Origin: null } }), 403)],
  ["foreign_origin", with_(post({ headers: { Origin: "https://evil.example.test" } }), 403)],
  ["foreign_origin_on_get", with_(get({ headers: { Origin: "https://evil.example.test" } }), 403)],
  ["foreign_host", with_(post({ headers: { Host: "evil.example.test" } }), 403)],
  ["fetch_site_cross_site", with_(post({ headers: { "Sec-Fetch-Site": "cross-site" } }), 403)],
  ["fetch_site_same_site", with_(post({ headers: { "Sec-Fetch-Site": "same-site" } }), 403)],
  ["fetch_site_none", with_(post({ headers: { "Sec-Fetch-Site": "none" } }), 403)],
  ["fetch_mode_navigate", with_(post({ headers: { "Sec-Fetch-Mode": "navigate" } }), 403)],
  ["fetch_dest_document", with_(post({ headers: { "Sec-Fetch-Dest": "document" } }), 403)],
  ["missing_x_morrow_request", with_(post({ headers: { "X-Morrow-Request": null } }), 403)],
  ["wrong_content_type", with_(post({ headers: { "Content-Type": "text/plain" } }), 403)],
  [
    "charset_content_type",
    with_(post({ headers: { "Content-Type": "application/json; charset=utf-8" } }), 403),
  ],
  // 401: credentials other than the one session cookie.
  ["authorization", with_(post({ headers: { Authorization: "Bearer " + workGuardSecret } }), 401)],
  ["proxy_authorization", with_(post({ headers: { "Proxy-Authorization": "Basic eA==" } }), 401)],
  ["zero_cookies", with_(post({ headers: { Cookie: null } }), 401)],
  [
    "two_cookies",
    with_(
      post({
        headers: {
          Cookie: `__Host-morrow_session=${workGuardSecret}; __Host-morrow_session=${workGuardSecret}`,
        },
      }),
      401,
    ),
  ],
  ["noncanonical_cookie", with_(post({ headers: { Cookie: "__Host-morrow_session=abc" } }), 401)],
  // 400: transport, body and key.
  [
    "transfer_encoding",
    with_(post({ headers: { "Transfer-Encoding": "chunked" } }), 400, { optional: true }),
  ],
  ["body_over_64_kib", with_(post({ body: goalWith({ objective: "x".repeat(65537) }) }), 400)],
  ["malformed_utf8", with_(post({ body: null, bytes: [0x7b, 0xff, 0xfe, 0x7d] }), 400)],
  [
    "duplicate_keys",
    with_(
      post({ body: '{"objective":"a","objective":"b","storeIds":[],"successCriteria":[]}' }),
      400,
    ),
  ],
  ["lone_surrogate", with_(post({ body: goal.replace('"Guarded"', '"\\ud800"') }), 400)],
  ["nul_escape", with_(post({ body: goal.replace('"Guarded"', '"a\\u0000b"') }), 400)],
  ["unknown_key", with_(post({ body: goalWith({ priority: 1 }) }), 400)],
  ["tenant_key_organization", with_(post({ body: goalWith({ organizationId: "org_o" }) }), 400)],
  ["tenant_key_workspace", with_(post({ body: goalWith({ workspaceId: "ws_w" }) }), 400)],
  ["tenant_key_principal", with_(post({ body: goalWith({ principalId: "person_a" }) }), 400)],
  ["missing_idempotency_key", with_(post({ headers: { "Idempotency-Key": null } }), 400)],
  [
    "uppercase_idempotency_key",
    with_(post({ headers: { "Idempotency-Key": key.toUpperCase() } }), 400),
  ],
  ["get_with_content_type", with_(get({ headers: { "Content-Type": "application/json" } }), 400)],
  ["get_with_idempotency_key", with_(get({ headers: { "Idempotency-Key": key } }), 400)],
  [
    "get_with_body_length",
    with_(get({ headers: { "Content-Length": "1" } }), 400, { optional: true }),
  ],
  ["unknown_query", with_(get({ path: "/workspace/ws_w/work/goals?token=x" }), 400)],
  ["bad_limit", with_(get({ path: "/workspace/ws_w/work/goals?limit=26" }), 400)],
  ["bad_cursor", with_(get({ path: "/workspace/ws_w/work/goals?after=!!" }), 400)],
  ["bad_path_id", with_(get({ path: "/workspace/ws_w/work/goals/%20" }), 400)],
  [
    "missing_respondent_me",
    with_(get({ path: "/workspace/ws_w/work/questions?status=open" }), 400),
  ],
  // 404 and 405.
  ["unknown_route", with_(get({ path: "/workspace/ws_w/work/projects" }), 404)],
  ["put_goals", with_({ ...get(), method: "PUT" }, 405, { allow: "GET, POST" })],
  [
    "delete_goal",
    with_({ ...get({ path: "/workspace/ws_w/work/goals/goal_1" }), method: "DELETE" }, 405, {
      allow: "GET",
    }),
  ],
]);

// Builds the Request in any runtime (Node or workerd).
export function workGuardRequest(c, origin = workGuardOrigin) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(c.headers ?? {}))
    if (value !== null && value !== undefined) headers.set(name, value);
  const init = { method: c.method, headers };
  if (c.method !== "GET" && c.method !== "HEAD" && c.method !== "DELETE") {
    if (c.bytes) init.body = new Uint8Array(c.bytes);
    else if (c.body !== undefined && c.body !== null) init.body = c.body;
  }
  return new Request(origin + c.path, init);
}
