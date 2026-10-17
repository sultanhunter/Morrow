# Workspace and connector entry contracts

Canonical plan sequence 22. Version-one draft contract, reviewed through synthetic fixtures; real authentication/merchant qualification remains pending.

HostContext is a standalone-only server bootstrap. ConnectorContext carries only verified installation/store/subject identity and constrained connection controls; it is not membership or domain authority. The historical CrossHostResume schema is now a single-use return-to-standalone record. No workspace feature tree is rendered in Admin. Server identity, ownership and policy checks remain mandatory after return. These unreleased draft enums are narrowed before any deployed consumer exists.

Closed schemas and fixtures live in schemas/v1/core.schema.json and fixtures/P01.A02.json. Current identity, grants, scope, revisions, budgets and policy are resolved by the backend. UI placement cannot confer authority.
