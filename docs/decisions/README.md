# Design and qualification decisions

The canonical build plan controls scope. Sequences 16–22 select deployment/models/data/billing and standalone Morrow with a thin Shopify connector. dependencies.json retains D01–D20 and adds D21 for billing/accounting. Recorded design is separate from engineering, controlled tests and provider permission; activation remains blocked.

Read infrastructure.md, deployment-policy.json, data-lifecycle.md, model-selection.md/model-policy.json, provider-feasibility.md, providers.json and provider-bindings.json. cost-model.json/capacity-targets.json hold partial cost arithmetic and unmeasured objectives. billing-ownership.md and readiness.json complete P01's accounting and documentary dependency review. Signed self-review evidence lives under docs/evidence/P01.T01–T04; it is not independent audit or merchant evidence.

Sources and test-account plans never grant provider access. Connector-only classification, billing eligibility, protected data, historical orders, theme exemption and business-provider approvals remain explicit account/activation/launch gates. Check billing-ownership.md for runnable prerequisites and owners.

Run npm run verify and npm test for deterministic design evidence. cost:estimate is a partial estimate only. P04/P08/P09/P12/P13/P17/P18 supply real infrastructure/account/execution/workflow qualification.
