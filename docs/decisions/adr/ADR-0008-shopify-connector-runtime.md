# ADR-0008 Shopify connector runtime: Cloudflare Workers with the `@shopify/shopify-api` web adapter

- Status: Accepted 2026-10-18
- Date: 2026-10-17 (drafted)
- Affects: P04.T02a §D8 (connector placeholder), P08.T02, P09.T01, P09.T02, P09.T04, P09.T05, `docs/contracts/shopify-sync.md`, `apps/shopify-connector`

## Context

- **Hosting.** The selected stack (owner selection, 2026-10-14) runs the connector as a separate Cloudflare Worker. A Node host is not selected.
- **Plan R1.** The P04.T02a bullet requires this connector-runtime ADR, because it is material. It names the default design that this ADR proposes: a Worker with Neon-backed session storage, using `@shopify/shopify-api`'s Workers/Web adapter where the React Router package cannot run, with secret-dependent Shopify operations in the broker. Until approval, only the placeholder of item 6 exists.
- **Locked dependency tree (measured 2026-10-17).**
  - `apps/shopify-connector` pins `@shopify/shopify-app-react-router` 3.0.1. Its package exports only a `server/adapters/node` adapter.
  - It depends on `@shopify/shopify-api` 15.0.0, which ships `cf-worker`, `web-api` and `node` adapters.
  - The current connector app builds with `@react-router/node` and runs under `react-router-serve`, a Node host.
- **Security invariant 11** puts provider credentials, including the Shopify app client secret and offline tokens, only in the broker. ADR-0007 bars Shopify credentials from the v0 broker until the P08.T02 trust model exists.
- **Security invariant 23:** a connector context is not a session. **Security invariant 3:** connector routes deny by default.
- **The current connector** is the P04.T02a 503 placeholder. No Shopify app, credential or call exists.

## Proposed decision

1. **Runtime.**
   - The connector is the Cloudflare Worker `morrow-<env>-connector`.
   - Deployed code uses `@shopify/shopify-api` through its Workers/Web adapter.
   - The React Router package's Node adapter and `react-router-serve` are not deployment targets, and no Node host is added.
2. **Secret placement.** The broker performs every operation that needs the app client secret:
   - the OAuth code exchange;
   - query HMAC verification;
   - webhook `X-Shopify-Hmac-Sha256` verification. This is a constant-time WebCrypto comparison over the raw body, before any JSON parse.

   The connector forwards the raw request to the broker over a service binding and binds no Shopify secret. Letting the connector bind only the HMAC secret is a deviation that needs separate owner sign-off.
3. **Trust model.** These broker operations are added only under the P08.T02 broker trust model and the P08 credential-custody ADR, never under the v0 model of ADR-0007.
4. **Session and token storage.** Shopify session storage is Neon-backed. Any token-bearing record follows the P08 credential-custody design: encrypted, in a broker-only schema that only the broker's database role can read. The connector Worker never reads raw offline tokens.
5. **Connector surface.** The connector serves install, link, status, reconnect, disconnect and return only. It resolves the installation from validated server context and never acts as a workspace session or authorizes domain capabilities (invariant 23; P09.T02).
6. **Until approval.** The connector remains the P04.T02a 503 placeholder. It binds only `MORROW_ENVIRONMENT`, and no Shopify secret, route or provider call exists.

## Consequences if accepted

- P09.T01 and P09.T02 engineering targets Workers and the web adapter. Embedded-presentation qualification (CSP, session token and cookie behaviour) stays in P09.T02.
- The existing React Router Node app in `apps/shopify-connector` becomes development scaffolding only. P09.T01 decides what of it is kept or replaced.
- The broker's Shopify methods, webhook ingress (P09.T04) and the compliance topics (P09.T05) follow `shopify-sync.md` and the P08.T02 broker.
- `@shopify/shopify-api` upgrades within the approved major version are routine (ADR-0002). A runtime or host change needs a superseding ADR.

## Alternatives considered

- **A Node host for the React Router app.** Not selected on 2026-10-14. It would add a hosting provider and a second runtime.
- **The connector binds the HMAC secret.** This places a provider secret outside the broker, contrary to invariant 11. It is allowed only by a separate owner-signed deviation.
- **React Router on Workers through an unofficial adapter.** Rejected: 3.0.1 ships no Workers adapter, and an unofficial one would be unsupported security-critical code.

## Approval

Owner approval, 2026-10-18, in chat. The owner selected **"Cloudflare Worker (Recommended)"** in answer to:

> Shopify connector runtime (ADR-0008, needed before the Shopify package, P09). Shopify's React Router app package only runs on Node, but its core @shopify/shopify-api library has a Cloudflare Workers adapter. Run the connector as a Cloudflare Worker on that library, so everything stays on one platform with keys in the broker?

The approved option read: "One platform and one deploy pipeline; secret-dependent Shopify calls stay in the broker. We write a little more glue than the template gives."

This approval selects the runtime only. Shopify credentials, routes, broker methods and deployment still follow the P08.T02 broker trust model and its credential-custody ADR (ADR-0007 item 4), and each hosted effect still needs its own approval.
