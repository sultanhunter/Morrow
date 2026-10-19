# Workspace routes and navigation

P02.T01, canonical sequence 24. Version-one unreleased catalogue; 15 existing IDs preserved, eleven required detail routes added. Reviewed input: P01; self-review only, merchant qualification pending. Owner Morrow platform owner.

## Primary and contextual destinations

Primary navigation is Home, Work, Inbox, Agents, Assets, Knowledge and Settings. Ask workspace is an objective-entry action, not a second competing Home. Projects are pinned Work records; selected tasks preserve their artifact/conversation tabs. Agent Store and builder live under Agents. Catalog/product views live under Assets; Connections and usage/billing under Settings. Domain filters expose all launch departments without thirteen competing primary navigation entries.

workspace-routes.json is the stable route source. Paths identify workspace and opaque record IDs, not credentials or derived grants. Home resolves to /w/:workspaceId; task, approval, artifact, product, agent, release, builder draft, connection, question, exception and knowledge detail have stable paths. Breadcrumbs follow each route's parent. Task artifact links retain both task and artifact ID. Settings section parameters are constrained to the declared list. Operator authoring stays a separate namespace/origin/session.

Deep links require server authentication/current membership/resource authority before data loads. URL match is never authorization. Denied/missing resources use a safe explanation without foreign names/counts. Login renewal returns to a validated logical location after fresh authorization; no arbitrary returnTo URL. One-use connector return resolves the permitted Morrow location, preserving task/proposal identity; the connector cannot render domain routes.

Store selection is a navigation filter. Task and proposal targets come from authoritative records and stay visibly pinned. Opening the same record in another authorized browser/session preserves target, persisted revision and current grants. Unsaved local text does not magically transfer; save/checkpoint must complete before a cross-session promise. Browser back/forward and reload preserve logical path and guard unsaved input.

The api Worker serves the SPA through Static Assets and reserves `/auth`, `/workspace`, `/api` and `/healthz` (and everything below them), plus the exact account paths `/workspaces` and `/organizations` (P05.T01x), for itself (`apps/api/src/reserved-paths.ts`; `/auth/challenge`, the P05.T01ab challenge configuration, falls under `/auth`); no route pattern may fall under a reserved prefix, which `npm run edge:check` enforces. Static destinations such as agents/new precede dynamic agent IDs. Opaque IDs may not use reserved route slugs. Decode once, validate IDs and re-encode; encoded slashes, traversal, foreign origins, unexpected parameters and token-bearing URLs deny. `packages/contracts/src/routes.ts` (`@morrow/contracts/routes`, generated from this catalogue) is the only matcher and builder; `/` matches only the `account` route. The workspace app (P14.T01a) implements router, authentication and session behavior on it.

## Connector boundary

Managed install/OAuth, linking, connection status, reconnect/disconnect and one-use return belong to the integration boundary. Connection controls require the appropriate verified subject/ownership and current policy; a displayed control is not a grant. Installation callbacks/auth endpoints are not merchant domain routes. Actual Shopify API paths and classification are qualified in P09. Connector store and Morrow navigation store remain separate values.

No full embedded workspace, parity obligation or Admin feature tree exists in this release. Responsive widths adapt the standalone screen system. Agent Store is labelled separately from the Shopify store. Applicable Shopify native controls belong only to the qualified connector UI.

## Evidence and compatibility

P02.A01 fixtures cover canonical route round-trips, static/detail precedence, parameter/credential injection and connector/operator separation; existing P01 binding fixtures cover immutable target/store authority. All screen components/data contracts are named in the catalogue. A path or component inventory does not implement a journey. P02.T03 prototypes and P02.T04 participant tests are required before feature UI qualification. Future route/version migrations retain old authorized links through explicit reviewed redirects, never by silently retargeting records.

## Account route (P05.T01x)

Route `account` (`/`) is the signed-in person's account view: `GET /workspaces` lists the workspaces they may enter now and whether first-owner signup is available (`AccountOverview`), and `POST /organizations` creates the first organization (`OrganizationSignupRequest`, `OrganizationSignupResult`). Selection is the URL `/w/{workspaceId}`; the server stores no active workspace, and every bootstrap rechecks eligibility. P14.T01a builds the screens.

