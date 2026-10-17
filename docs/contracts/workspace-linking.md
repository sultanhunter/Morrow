# Workspace and installation linking

Canonical plan sequence 22. Version-one draft contract, reviewed through synthetic fixtures; real authentication/merchant qualification remains pending.

Workspace-first and install-first paths separately verify Morrow membership and Shopify installation. A single-use handoff binds principal, installation, workspace, nonce, purpose, ownership revision and expiry. Atomically consume after verification; repeated callbacks return the already linked result or denial without reassignment. Email equality grants nothing. Connector context cannot become workspace authority. Resume existing authorized records in standalone Morrow.

Closed schemas and fixtures live in schemas/v1/core.schema.json and fixtures/P01.A02.json. Current identity, grants, scope, revisions, budgets and policy are resolved by the backend. UI placement cannot confer authority.

P05.T03a at canonical68 implements the private first-claim persistence boundary with controlled fixtures. An unassigned stable provider subject is not a tenant-owned StoreInstallation; the private association establishes real organization/workspace ownership without inventing connector/vault fields. One current human connect/administer grant and a separately reviewed five-minute handoff must bind the same command, actor/session, nonce, target, installation generation, exact requested scope/proof and expected revisions. Fresh commands cannot overwrite an existing owner; cross-host resume and reconnect are separate integrations. Exact committed replay only reconciles its immutable result after current authority and ownership checks. See the canonical Page and docs/packets/P05.T03a.md for the active protocol; frozen v1 schemas remain unchanged.
