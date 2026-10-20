// The fake Stripe origin (M5 PR-1): the only "Stripe" any test or lab talks to. It answers
// exactly the calls apps/broker/src/stripe.ts makes on the pinned API version, from
// in-memory state seeded with the synthetic fixtures of tests/fixtures/stripe/, and signs
// webhook events with a lab-only secret. Nothing here reaches the network: `fetch` is an
// in-process function, and `listen()` serves it on 127.0.0.1 for Worker labs.
//
// Behaviour that matters for invariant 10 (reconcile before retry):
//   * POST requests with an Idempotency-Key replay the saved result for the same key and
//     parameters (2xx and, as Stripe does once execution began, a 500), and answer 400
//     idempotency_error for the same key with other parameters;
//   * faults, consumed in order: `500_after` (the effect happens, the saved reply is a
//     500), `500_before` (no effect), `lost_after` (the effect happens and is saved, the
//     reply is lost: a transport error), `lost_before`, `429` (no effect, Retry-After 0),
//     `400` (no effect);
//   * `searchLag` hides new customers from search, as Stripe's search index lags.
// Every request is recorded (method, path, query, Idempotency-Key, form, authorised).
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { stripeFixture } from "../../tests/fixtures/stripe-fixtures.mjs";

export const fakeStripeVersion = "2025-03-31.basil";
export const fakeStripeKey = "rk_test_" + "LabRestrictedKey".padEnd(32, "0");
export const fakeStripeWebhookSecret = "whsec_" + "LabWebhookSecret".padEnd(32, "0");
export const fakeStripePrice = "price_MorrowDevBeta0049";

const alnum = (n) =>
  [...randomBytes(n)]
    .map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62])
    .join("");
const nested = (form, prefix) =>
  Object.fromEntries(
    Object.entries(form)
      .filter(([k]) => k.startsWith(prefix + "[") && k.endsWith("]"))
      .map(([k, v]) => [k.slice(prefix.length + 1, -1), v]),
  );

export function createStripeFake({
  restrictedKey = fakeStripeKey,
  webhookSecret = fakeStripeWebhookSecret,
  now = () => Date.now(),
} = {}) {
  const customers = new Map();
  const sessions = new Map();
  const portals = new Map();
  const subscriptions = new Map();
  const invoices = new Map();
  const saved = new Map();
  const requests = [];
  const faults = [];
  const options = { searchLag: false };
  const seconds = () => Math.floor(now() / 1000);

  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "request-id": "req_" + alnum(14),
        "stripe-version": fakeStripeVersion,
        ...extra,
      },
    });
  const error = (status, type, code = null) =>
    json(status, { error: { type, code, message: "fake " + type } });

  function nextFault(method, path) {
    const index = faults.findIndex(
      (f) =>
        f.method === method && (typeof f.path === "string" ? f.path === path : f.path.test(path)),
    );
    return index < 0 ? null : faults.splice(index, 1)[0].kind;
  }

  // The effects, by route. Each returns [status, body].
  function createCustomer(form) {
    const id = "cus_" + alnum(14);
    const customer = {
      id,
      object: "customer",
      created: seconds(),
      email: null,
      livemode: false,
      metadata: nested(form, "metadata"),
    };
    customers.set(id, customer);
    return [200, customer];
  }
  function createSession(form) {
    const customer = customers.get(form.customer);
    if (!customer)
      return [400, { error: { type: "invalid_request_error", code: "resource_missing" } }];
    if (form.mode !== "subscription" || form["line_items[0][price]"] !== fakeStripePrice)
      return [400, { error: { type: "invalid_request_error", code: "parameter_invalid" } }];
    const id = "cs_test_" + alnum(24);
    const session = {
      id,
      object: "checkout.session",
      customer: customer.id,
      customer_email: null,
      expires_at: Number(form.expires_at),
      livemode: false,
      metadata: nested(form, "metadata"),
      mode: "subscription",
      status: "open",
      subscription: null,
      success_url: form.success_url,
      cancel_url: form.cancel_url,
      url: "https://checkout.stripe.com/c/pay/" + id,
      _subscriptionMetadata: nested(form, "subscription_data[metadata]"),
      _form: form,
    };
    sessions.set(id, session);
    return [200, publicSession(session)];
  }
  const publicSession = (s) => {
    const { _subscriptionMetadata, _form, ...rest } = s;
    void _subscriptionMetadata;
    void _form;
    return { ...rest, url: s.status === "open" ? s.url : null };
  };
  function createPortal(form) {
    if (!customers.has(form.customer) || !/^bpc_/.test(form.configuration ?? ""))
      return [400, { error: { type: "invalid_request_error", code: "resource_missing" } }];
    const id = "bps_" + alnum(24);
    const portal = {
      id,
      object: "billing_portal.session",
      configuration: form.configuration,
      customer: form.customer,
      livemode: false,
      return_url: form.return_url,
      url: "https://billing.stripe.com/p/session/test_" + alnum(24),
    };
    portals.set(id, portal);
    return [200, portal];
  }

  async function handle(request) {
    const url = new URL(request.url);
    const form =
      request.method === "POST"
        ? Object.fromEntries(new URLSearchParams(await request.text()))
        : {};
    const authorised =
      request.headers.get("authorization") === "Bearer " + restrictedKey &&
      request.headers.get("stripe-version") === fakeStripeVersion;
    const key = request.headers.get("idempotency-key");
    requests.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      idempotencyKey: key,
      form,
      authorised,
    });
    if (url.origin !== "https://api.stripe.com") throw new TypeError("fetch failed");
    if (!authorised) return error(401, "invalid_request_error", "api_key_invalid");
    const fault = nextFault(request.method, url.pathname);
    if (fault === "lost_before") throw new TypeError("network lost");
    if (fault === "500_before") return error(500, "api_error");
    if (fault === "429") return error(429, "rate_limit_error");
    if (fault === "400") return error(400, "invalid_request_error", "parameter_invalid");
    if (request.method === "POST") {
      const fingerprint = url.pathname + "?" + JSON.stringify(Object.entries(form).sort());
      if (key && saved.has(key)) {
        const previous = saved.get(key);
        if (previous.fingerprint !== fingerprint)
          return error(400, "idempotency_error", "idempotency_key_in_use");
        return json(previous.status, previous.body, { "idempotent-replayed": "true" });
      }
      const route = {
        "/v1/customers": createCustomer,
        "/v1/checkout/sessions": createSession,
        "/v1/billing_portal/sessions": createPortal,
      }[url.pathname];
      if (!route) return error(404, "invalid_request_error", "resource_missing");
      let [status, body] = route(form);
      if (fault === "500_after") [status, body] = [500, { error: { type: "api_error" } }];
      if (key && status !== 400) saved.set(key, { fingerprint, status, body });
      if (fault === "lost_after") throw new TypeError("network lost");
      return json(status, body);
    }
    // Reads.
    const [, , collection, id, extra] = url.pathname.split("/");
    const found = (map) =>
      map.has(id)
        ? json(200, map.get(id))
        : error(404, "invalid_request_error", "resource_missing");
    if (collection === "customers" && id === "search") {
      const match = /^metadata\['morrow_operation_id'\]:'([a-f0-9-]{36})'$/.exec(
        url.searchParams.get("query") ?? "",
      );
      if (!match) return error(400, "invalid_request_error", "parameter_invalid");
      const data = options.searchLag
        ? []
        : [...customers.values()].filter((c) => c.metadata.morrow_operation_id === match[1]);
      return json(200, { object: "search_result", data, has_more: false });
    }
    if (collection === "customers" && extra === undefined) return found(customers);
    if (collection === "checkout" && id === "sessions") {
      const sessionId = extra;
      if (sessionId === undefined) {
        const customer = url.searchParams.get("customer");
        const data = [...sessions.values()]
          .filter((s) => s.customer === customer)
          .map(publicSession);
        return json(200, { object: "list", data, has_more: false });
      }
      return sessions.has(sessionId)
        ? json(200, publicSession(sessions.get(sessionId)))
        : error(404, "invalid_request_error", "resource_missing");
    }
    if (collection === "subscriptions") return found(subscriptions);
    if (collection === "invoices") return found(invoices);
    return error(404, "invalid_request_error", "resource_missing");
  }

  // ---------------------------------------------------------------------------
  // Test drivers: what the customer and Stripe's billing engine do after Checkout.
  function invoiceFor(subscription, reason, { start, end, paid = true } = {}) {
    const id = "in_" + alnum(16);
    const meta = subscription.metadata;
    const invoice = stripeFixture(
      reason === "subscription_create"
        ? "invoice.paid.subscription_create"
        : paid
          ? "invoice.paid.subscription_cycle"
          : "invoice.payment_failed",
      {
        customer: subscription.customer,
        subscription: subscription.id,
        invoice: id,
        operationId: meta.morrow_operation_id ?? null,
        workspaceId: meta.morrow_workspace_id ?? null,
        organizationId: meta.morrow_organization_id ?? null,
      },
      (o) => {
        o.billing_reason = reason;
        o.lines.data[0].period = { start, end };
        o.created = start;
      },
    );
    invoices.set(invoice.id, invoice);
    return invoice;
  }
  /** The customer completes Checkout: a subscription and its first paid invoice. */
  function complete(
    sessionId,
    { periodStart = seconds() - 60, periodEnd = seconds() + 30 * 86400 } = {},
  ) {
    const session = sessions.get(sessionId);
    if (!session || session.status !== "open") throw Error("FAKE_STRIPE_SESSION_NOT_OPEN");
    const subscriptionId = "sub_" + alnum(16);
    const subscription = stripeFixture(
      "subscription.active",
      {
        customer: session.customer,
        subscription: subscriptionId,
        operationId: session._subscriptionMetadata.morrow_operation_id ?? null,
        workspaceId: session._subscriptionMetadata.morrow_workspace_id ?? null,
        organizationId: session._subscriptionMetadata.morrow_organization_id ?? null,
      },
      (o) => {
        o.items.data[0].current_period_start = periodStart;
        o.items.data[0].current_period_end = periodEnd;
      },
    );
    subscriptions.set(subscriptionId, subscription);
    session.status = "complete";
    session.subscription = subscriptionId;
    const invoice = invoiceFor(subscription, "subscription_create", {
      start: periodStart,
      end: periodEnd,
    });
    return { session: publicSession(session), subscription, invoice };
  }
  /** Stripe expires an open session. */
  function expire(sessionId) {
    const session = sessions.get(sessionId);
    session.status = "expired";
    return publicSession(session);
  }
  /** The next period's invoice. */
  function cycle(subscriptionId, { periodStart, periodEnd, paid = true }) {
    const subscription = subscriptions.get(subscriptionId);
    subscription.items.data[0].current_period_start = periodStart;
    subscription.items.data[0].current_period_end = periodEnd;
    return invoiceFor(subscription, "subscription_cycle", {
      start: periodStart,
      end: periodEnd,
      paid,
    });
  }
  /** The portal's cancellation: at period end, or at a time. */
  function cancel(subscriptionId, { atPeriodEnd = true, at = null } = {}) {
    const subscription = subscriptions.get(subscriptionId);
    subscription.cancel_at_period_end = atPeriodEnd;
    subscription.cancel_at = at;
    return subscription;
  }
  function end(subscriptionId) {
    const subscription = subscriptions.get(subscriptionId);
    subscription.status = "canceled";
    subscription.canceled_at = seconds();
    return subscription;
  }

  /** A signed webhook delivery: the exact bytes and the Stripe-Signature header. */
  function signedEvent(
    type,
    object,
    {
      id = "evt_" + alnum(24),
      timestamp = seconds(),
      secret = webhookSecret,
      livemode = false,
    } = {},
  ) {
    const body = JSON.stringify({
      id,
      object: "event",
      api_version: fakeStripeVersion,
      created: timestamp,
      data: { object },
      livemode,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
    });
    const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    return { id, body, signature: `t=${timestamp},v1=${v1}` };
  }

  /** Serves `fetch` on 127.0.0.1 (Worker labs rewrite api.stripe.com to it). */
  async function listen() {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const response = await handle(
          new Request("https://api.stripe.com" + req.url, {
            method: req.method,
            headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
            body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        req.socket.destroy();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  return Object.freeze({
    fetch: (request) => handle(request),
    requests,
    faults,
    options,
    state: Object.freeze({ customers, sessions, portals, subscriptions, invoices, saved }),
    complete,
    expire,
    cycle,
    cancel,
    end,
    signedEvent,
    listen,
  });
}
