# Workspace and installation linking

Canonical plan sequence 22. Version-one draft contract, reviewed through synthetic fixtures; real authentication/merchant qualification remains pending.

Workspace-first and install-first paths separately verify Morrow membership and Shopify installation. A single-use handoff binds principal, installation, workspace, nonce, purpose, ownership revision and expiry. Atomically consume after verification; repeated callbacks return the already linked result or denial without reassignment. Email equality grants nothing. Connector context cannot become workspace authority. Resume existing authorized records in standalone Morrow.

Closed schemas and fixtures live in schemas/v1/core.schema.json and fixtures/P01.A02.json. Current identity, grants, scope, revisions, budgets and policy are resolved by the backend. UI placement cannot confer authority.
