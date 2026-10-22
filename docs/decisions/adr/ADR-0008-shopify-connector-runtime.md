# ADR-0008 Shopify connector runtime: Cloudflare Workers with the `@shopify/shopify-api` web adapter

- Status: Accepted 2026-10-18
- Amended: item 1, 2026-10-20 (M2 PR-2: no Shopify library in deployed code). See Amendments.
- Date: 2026-10-17 (drafted)
- Affects: P04.T02a §D8 (connector placeholder), P08.T02, P09.T01, P09.T02, P09.T04, P09.T05, `docs/contracts/shopify-sync.md`, `apps/shopify-connector`

## Context

- **Hosting.** The selected stack (owner selection, 2026-10-14) runs the connector as a separate Cloudflare Worker. A Node host is not selected.
- **Plan R1.** The P04.T02a bullet requires this connector-runtime ADR, because it is material. It named the default design this ADR records: a Worker with Neon-backed session storage, using `@shopify/shopify-api`'s Workers/Web adapter where the React Router package cannot run, with secret-dependent Shopify operations in the broker.
- **Locked dependency tree (measured 2026-10-17).**
  - `apps/shopify-connector` pins `@shopify/shopify-app-react-router` 3.0.1. Its package exports only a `server/adapters/node` adapter.
  - It depends on `@shopify/shopify-api` 15.0.0, which ships `cf-worker`, `web-api` and `node` adapters.
  - The current connector app builds with `@react-router/node` and runs under `react-router-serve`, a Node host.
- **Security invariant 11** puts provider credentials, including the Shopify app client secret and offline tokens, only in the broker. ADR-0007 bars Shopify credentials from the v0 broker until the P08.T02 trust model exists.
- **Security invariant 23:** a connector context is not a session. **Security invariant 3:** connector routes deny by default.
- **The current connector** is the P04.T02a 503 placeholder. No Shopify app, credential or call exists.

## Decision

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
6. **Until P09.T01.** The connector remains the P04.T02a 503 placeholder, and it binds only `MORROW_ENVIRONMENT`. No Shopify secret or broker operation exists before P08.T02 and the P08 credential-custody ADR.

## Consequences

- P09.T01 and P09.T02 engineering targets Workers and the web adapter. Embedded-presentation qualification (CSP, session token and cookie behaviour) stays in P09.T02.
- The existing React Router Node app in `apps/shopify-connector` becomes development scaffolding only. P09.T01 decides what of it is kept or replaced.
- The broker's Shopify methods, webhook ingress (P09.T04) and the compliance topics (P09.T05) follow `shopify-sync.md` and the P08.T02 broker.
- `@shopify/shopify-api` upgrades within the approved major version are routine (ADR-0002). A runtime or host change needs a superseding ADR.
- In the locked `@shopify/shopify-api` 15.0.0, `shopifyApi()` will not initialize without `apiSecretKey`. Because the connector binds no secret, only the broker can initialize the library with the real secret. P09.T01 records how the connector uses the library's secret-free parts and delegates the rest to the broker. This is the extra glue the owner accepted.

## Alternatives considered

- **A Node host for the React Router app.** Not selected on 2026-10-14. It would add a hosting provider and a second runtime.
- **The connector binds the HMAC secret.** This places a provider secret outside the broker, contrary to invariant 11. It is allowed only by a separate owner-signed deviation.
- **React Router on Workers through an unofficial adapter.** Rejected: 3.0.1 ships no Workers adapter, and an unofficial one would be unsupported security-critical code.

## Approval

Owner approval, 2026-10-18, in chat. The owner selected **"Cloudflare Worker (Recommended)"** in answer to:

> Shopify connector runtime (ADR-0008, needed before the Shopify package, P09). Shopify's React Router app package only runs on Node, but its core @shopify/shopify-api library has a Cloudflare Workers adapter. Run the connector as a Cloudflare Worker on that library, so everything stays on one platform with keys in the broker?

The approved option read: "One platform and one deploy pipeline; secret-dependent Shopify calls stay in the broker. We write a little more glue than the template gives."

Scope of the approval:

- **Decided by the owner's answer:** item 1 (runtime: a Cloudflare Worker on `@shopify/shopify-api`) and item 2 (every secret-dependent Shopify call stays in the broker).
- **Restated from existing records:** item 3 restates ADR-0007 item 4. Item 5 restates the settled thin-connector scope and Security invariant 23. Item 6 follows from ADR-0007 and P04.T02a.
- **Not covered by the question:** item 4. Neon-backed session storage follows the selected stack. Its token-custody details stay subject to the owner-approved P08 credential-custody ADR, which is not yet written (see ADR-0007 item 4).

Shopify credentials, routes, broker methods and deployment still need that P08 ADR and the P08.T02 broker trust model. Each hosted effect still needs its own approval.

## Amendments

### 2026-10-20: item 1, no Shopify library in deployed code (M2 PR-2)

Item 1's second bullet now reads:

> Deployed code uses no Shopify library. The broker implements, by hand and behind the item 2 boundary:
> - the query HMAC and webhook `X-Shopify-Hmac-Sha256` checks (WebCrypto, constant time, over the raw bytes);
> - the authorization-code exchange;
> - fixed Admin GraphQL documents, starting with one product query.
>
> Any later Admin API call (M4's product update and its readback) is likewise a fixed document in the broker, reviewed with its PR. The connector Worker holds no secret and imports no Shopify package. `@shopify/shopify-api` may stay a development dependency for fixtures and contract checks only.

Reason: in the locked `@shopify/shopify-api` 15.0.0, `shopifyApi()` will not initialise without `apiSecretKey` (Consequences). The secret stays in the broker (item 2), and the broker bundle is capped at 256 KiB, so the library would have to run inside the broker. The broker must also leave room for the Neon driver, Stripe (M5) and the Claude adapter (M3 PR-2). M2 PR-2 pins the hand-written checks with tests against Shopify's documented HMAC and OAuth examples.

Items 2–6 are unchanged. The title and the Consequences bullets that name `@shopify/shopify-api` as the deployed runtime describe item 1 before this amendment.

Owner decision, 2026-10-20, in chat. The question was: "Your earlier decision (ADR-0008 item 1) says deployed code uses the official @shopify/shopify-api library. The library needs the app secret wherever it runs, the secret must stay in the broker, and the broker's bundle is capped at 256 KiB. What should we do?" The owner answered: "Hand-written checks (Recommended)". The option read: "The broker does Shopify's signature checks, the install code exchange and one fixed product query itself. That's small and easy to audit, and the connector holds no secret. Amends ADR-0008 item 1."

### 2026-10-22 note: broker bundle bound (owner-approved)

The 2026-10-20 amendment cites a 256 KiB broker bundle cap. The cap (P04.T02a-AC02, `edgeBundleLimits.brokerBytes` in `scripts/edge.mjs`) is now 384 KiB (393,216 bytes) minified: M2 PR-3 plus M3 PR-2 measured 264,479 bytes, 56% of it the Neon driver. The bound still keeps the broker small and auditable. Item 1 as amended is unchanged: the hand-written Shopify checks and the plain HTTPS Claude adapter remain the choice.

Owner approval, 2026-10-22, in chat. The morning report asked to raise the broker size limit, recommending 384 KiB, and the owner replied, verbatim: "yes to all recommended, for CI lets use our mac". The owner gave this answer in the main session; it is the one the merge train's briefs cite.
