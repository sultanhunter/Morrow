import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectImports,
  inspectCompatibility,
  inspectBaselineCoverage,
  inspectDeclaredReplacements,
  inspectSupersededUse,
  inspectRefinedSelectorUse,
  inspectEventRegistryBaseline,
  inspectEntitlementWriters,
  replacedDefinitionNames,
  replacedBillingDefinitionNames,
  isBoundarySource,
} from "./boundary-checks.mjs";
import {
  changesPath,
  readEventRegistry,
  readSchemaSources,
  schemasByKind,
} from "./contract-sources.mjs";
import { writeArtifact } from "./artifacts.mjs";
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + entry.name;
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "build", ".react-router"].includes(entry.name)) walk(p);
    } else if (isBoundarySource(p)) files.push(p);
  }
}
walk("apps");
walk("packages");
const schemaFiles = [];
(function schemaWalk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + entry.name;
    if (entry.isDirectory()) schemaWalk(p);
    else if (p.endsWith(".schema.json")) schemaFiles.push(p);
  }
})("docs/contracts/schemas");
const errors = files.flatMap((p) =>
  inspectImports(p, readFileSync(p, "utf8")).map((e) => p + ":" + e),
);
const baseline = JSON.parse(readFileSync("docs/contracts/release-baseline.json", "utf8"));
const schemas = Object.fromEntries(
  Object.keys(baseline.schemas).map((p) => [p, readFileSync(p, "utf8")]),
);
errors.push(...inspectCompatibility(baseline, schemas));
errors.push(...inspectBaselineCoverage(baseline, schemaFiles));
// The event registry is append-only against its pinned rows (ADR-0016 item 6).
const registry = readEventRegistry();
errors.push(...inspectEventRegistryBaseline(baseline, registry));
const changes = JSON.parse(readFileSync(changesPath, "utf8"));
const layered = schemasByKind(readSchemaSources());
errors.push(...inspectDeclaredReplacements(changes, layered));
// Product code never validates or types a replaced v1 definition (P01.T02a AC11;
// billing replacements, P01.T04a AC30).
const replaced = replacedDefinitionNames(changes);
const replacedBilling = replacedBillingDefinitionNames(changes);
for (const p of files)
  errors.push(...inspectSupersededUse(p, readFileSync(p, "utf8"), replaced, replacedBilling));
// Refined v1.1 definitions are validated only through validateCurrentDefinition (P01.T02c).
for (const p of files) errors.push(...inspectRefinedSelectorUse(p, readFileSync(p, "utf8")));
// Only the billing reader and its two forwarders set entitlementAllowed (P01.T04a AC29).
for (const p of files) errors.push(...inspectEntitlementWriters(p, readFileSync(p, "utf8")));
const negatives = [
  ["host_sdk", "import {x} from '@shopify/shopify-app-react-router/server';", "UI_SERVER_IMPORT"],
  ["relative_api", "import {x} from '../../api/src/index';", "UI_RELATIVE_ESCAPE"],
  ["export_secret", "export {x} from './secrets.server';", "UI_SERVER_IMPORT"],
  ["server_env", "const x=process.env.SHOPIFY_API_SECRET;", "UI_SERVER_ENVIRONMENT"],
  ["dynamic_secret", "const x=import(variable);", "DYNAMIC_IMPORT_UNREVIEWED"],
  ["runtime", "import {x} from '@morrow/runtime';", "TRUST_BOUNDARY_IMPORT"],
  ["broker", "import {x} from '@morrow/broker';", "TRUST_BOUNDARY_IMPORT"],
].map(([name, code, expected]) => ({
  name,
  passed: inspectImports("apps/workspace-web/src/test.tsx", code).includes(expected),
}));
for (const [name, path, code, expected] of [
  ...[
    ["daytona", "@daytona/sdk"],
    ["e2b", "@e2b/code-interpreter"],
    ["modal", "@modal-labs/sdk"],
    ["blaxel", "@blaxel/core"],
    ["sprites", "@fly/sprites"],
    ["cloudflare", "@cloudflare/sandbox"],
  ].map(([name, specifier]) => [
    `runtime_sdk_${name}`,
    "packages/runtime/src/harness.ts",
    `import {Client} from '${specifier}';`,
    "RUNTIME_SDK_OUTSIDE_ADAPTER",
  ]),
  [
    "runtime_sdk_type_query",
    "packages/contracts/src/index.ts",
    "type X = import('@daytona/sdk').Client;",
    "RUNTIME_SDK_OUTSIDE_ADAPTER",
  ],
  [
    "runtime_sdk_import_equals",
    "packages/runtime/src/harness.ts",
    "import X = require('e2b');",
    "RUNTIME_SDK_OUTSIDE_ADAPTER",
  ],
  [
    "runtime_sdk_ui_folder_impostor",
    "apps/workspace-web/src/runtime-adapters/daytona/client.ts",
    "import {Client} from '@daytona/sdk';",
    "RUNTIME_SDK_OUTSIDE_ADAPTER",
  ],
  [
    "runtime_adapter_api_import",
    "apps/api/src/index.ts",
    "import {createProvider} from '@morrow/runtime-adapters/daytona';",
    "RUNTIME_ADAPTER_IMPORT_DENIED",
  ],
  [
    "runtime_adapter_relative_escape",
    "packages/runtime/src/harness.ts",
    "export {createProvider} from '../../runtime-adapters/src/daytona/client';",
    "RUNTIME_ADAPTER_IMPORT_DENIED",
  ],
  [
    "runtime_sdk_wrong_provider_adapter",
    "packages/runtime-adapters/src/daytona/client.ts",
    "import {Client} from 'e2b';",
    "RUNTIME_SDK_OUTSIDE_ADAPTER",
  ],
  [
    "runtime_sdk_node_modules_escape",
    "packages/identity/src/index.ts",
    "import {Client} from '../../../node_modules/@daytona/sdk';",
    "RUNTIME_SDK_OUTSIDE_ADAPTER",
  ],
  [
    "runtime_sdk_wrapped_require",
    "packages/runtime/src/harness.js",
    "const x = require.call(null, '@daytona/sdk');",
    "MODULE_LOADER_UNREVIEWED",
  ],
  [
    "runtime_sdk_module_require",
    "packages/runtime/src/harness.cjs",
    "const x = module.require('e2b');",
    "MODULE_LOADER_UNREVIEWED",
  ],
  [
    "runtime_sdk_parenthesized_require",
    "packages/runtime/src/harness.cts",
    "const x = (require)('e2b');",
    "MODULE_LOADER_UNREVIEWED",
  ],
  [
    "runtime_custom_loader",
    "packages/runtime/src/harness.mjs",
    "import {createRequire} from 'node:module';",
    "RUNTIME_LOADER_OUTSIDE_ADAPTER",
  ],
  [
    "runtime_core_alias_escape",
    "packages/runtime/src/harness.mts",
    "import {compose} from '@morrow/workers/runtime-provider-composition.server';",
    "RUNTIME_CORE_DEPENDENCY_DENIED",
  ],
  [
    "runtime_adapter_sibling_alias",
    "packages/runtime-adapters/src/daytona/client.ts",
    "import {createProvider} from '@morrow/runtime-adapters/e2b';",
    "RUNTIME_ADAPTER_PROVIDER_MISMATCH",
  ],
  [
    "runtime_adapter_sibling_relative",
    "packages/runtime-adapters/src/daytona/client.ts",
    "import {createProvider} from '../e2b/client';",
    "RUNTIME_ADAPTER_PROVIDER_MISMATCH",
  ],
  [
    "broker_source_from_api",
    "apps/api/src/deployed-worker.ts",
    "import {brokerNeonLease} from '../../broker/src/neon-lease';",
    "BROKER_SOURCE_IMPORT",
  ],
  [
    "broker_package_from_api",
    "apps/api/src/deployed-worker.ts",
    "import {ApiBroker} from '@morrow/broker';",
    "BROKER_SOURCE_IMPORT",
  ],
  [
    "api_source_from_broker",
    "apps/broker/src/index.ts",
    "import {composeApiDependencies} from '../../api/src/deployed-worker';",
    "BROKER_APP_IMPORT",
  ],
  // M5 PR-1: Stripe only in the broker, and never through an SDK.
  [
    "stripe_origin_from_api",
    "apps/api/src/worker.ts",
    "const origin = 'https://api.stripe.com/v1/customers';",
    "STRIPE_OUTSIDE_BROKER",
  ],
  [
    "stripe_origin_template_from_work",
    "packages/work/src/billing/http.ts",
    "const url = `https://API.stripe.com/v1/${path}`;",
    "STRIPE_OUTSIDE_BROKER",
  ],
  [
    "stripe_sdk_from_work",
    "packages/work/src/billing/commands.ts",
    "import Stripe from 'stripe';",
    "STRIPE_OUTSIDE_BROKER",
  ],
  [
    "stripe_js_from_ui",
    "packages/workspace-ui/src/x.ts",
    "import {loadStripe} from '@stripe/stripe-js';",
    "STRIPE_OUTSIDE_BROKER",
  ],
  [
    "stripe_sdk_in_broker",
    "apps/broker/src/stripe.ts",
    "import Stripe from 'stripe';",
    "STRIPE_SDK_DENIED",
  ],
  // P14.T01a §4.11 (a) and §5: fixture isolation and UI sinks.
  [
    "fixture_from_app",
    "apps/workspace-web/src/app.tsx",
    "import {createFixtureAdapter} from './fixtures/adapter';",
    "UI_FIXTURE_IMPORT",
  ],
  [
    "fixture_from_ui_package",
    "packages/workspace-ui/src/index.ts",
    "export * from '../../../apps/workspace-web/src/fixtures/seed';",
    "UI_FIXTURE_IMPORT",
  ],
  [
    "html_sink_jsx",
    "packages/workspace-ui/src/screens/x.tsx",
    "const a = <div dangerouslySetInnerHTML={{ __html: text }} />;",
    "UI_HTML_SINK",
  ],
  ["html_sink_property", "apps/workspace-web/src/x.ts", "node.innerHTML = text;", "UI_HTML_SINK"],
  ["html_sink_write", "apps/workspace-web/src/x.ts", "document.write(text);", "UI_HTML_SINK"],
  [
    "cookie_access",
    "apps/workspace-web/src/x.ts",
    "const c = document.cookie;",
    "UI_COOKIE_ACCESS",
  ],
  ["eval", "apps/workspace-web/src/x.ts", "eval(text);", "UI_DYNAMIC_CODE"],
  ["function_constructor", "apps/workspace-web/src/x.ts", "new Function(text);", "UI_DYNAMIC_CODE"],
  [
    "local_storage",
    "packages/workspace-ui/src/x.ts",
    "localStorage.setItem('a', 'b');",
    "UI_LOCAL_STORAGE",
  ],
  [
    "session_storage_outside_owner",
    "apps/workspace-web/src/app.tsx",
    "sessionStorage.getItem('morrow.intended.v1');",
    "UI_SESSION_STORAGE_OUTSIDE_OWNER",
  ],
  [
    "runtime_adapter_absolute_import",
    "apps/api/src/index.ts",
    `import {createProvider} from ${JSON.stringify(resolve("packages/runtime-adapters/src/e2b/client.ts"))};`,
    "RUNTIME_ADAPTER_IMPORT_DENIED",
  ],
  [
    "test_fixture_import",
    "packages/work/src/approvals/index.ts",
    "import { approvalProducers } from '../../../../tests/fixtures/approval-producers.mjs';",
    "TEST_FIXTURE_IMPORT",
  ],
  [
    "runtime_adapter_file_url_import",
    "packages/runtime/src/harness.mts",
    `import {createProvider} from ${JSON.stringify(pathToFileURL(resolve("packages/runtime-adapters/src/e2b/client.ts")).href)};`,
    "RUNTIME_ADAPTER_IMPORT_DENIED",
  ],
])
  negatives.push({ name, passed: inspectImports(path, code).includes(expected) });
const changed = { ...schemas };
const first = Object.keys(changed)[0];
const value = JSON.parse(changed[first]);
value.$defs.Id.type = "number";
changed[first] = JSON.stringify(value);
negatives.push({
  name: "incompatible_schema_type",
  passed: inspectCompatibility(baseline, changed).length > 0,
});
negatives.push({
  name: "unbaselined_schema",
  passed: inspectBaselineCoverage(baseline, [
    ...schemaFiles,
    "docs/contracts/schemas/v1.1/extra.schema.json",
  ]).includes("UNBASELINED_SCHEMA:docs/contracts/schemas/v1.1/extra.schema.json"),
});
negatives.push({
  name: "undeclared_body_override",
  passed: inspectDeclaredReplacements(
    { ...changes, changes: changes.changes.filter((c) => c.name !== "ads.campaign.pause.input") },
    layered,
  ).includes("UNDECLARED_REPLACEMENT:ads.campaign.pause.input"),
});
negatives.push({
  name: "undeclared_billing_replacement",
  passed: inspectDeclaredReplacements(
    { ...changes, changes: changes.changes.filter((c) => c.name !== "BillingAccount") },
    layered,
  ).includes("UNDECLARED_REPLACEMENT:BillingAccount"),
});
const reused = structuredClone(layered);
reused["core-v1.1"].$defs.Task = reused.core.$defs.Task;
negatives.push({
  name: "undeclared_definition_reuse",
  passed: inspectDeclaredReplacements(changes, reused).includes("UNDECLARED_REPLACEMENT:Task"),
});
for (const [name, path, code, expected] of [
  [
    "superseded_validate_definition",
    "packages/policy/src/review.ts",
    'validateDefinition("core", "Proposal", value);',
    "SUPERSEDED_CONTRACT_USE:packages/policy/src/review.ts:Proposal",
  ],
  [
    "superseded_type_reference",
    "apps/api/src/index.ts",
    'import type { Core_Approval } from "@morrow/contracts";',
    "SUPERSEDED_CONTRACT_USE:apps/api/src/index.ts:Approval",
  ],
  [
    "superseded_selector",
    "packages/policy/src/review.ts",
    'const check = validators["core:Approval"];',
    "SUPERSEDED_CONTRACT_USE:packages/policy/src/review.ts:Approval",
  ],
  // ADR-0022 item 2: a v1 Grant read would refuse every store-link grant.
  [
    "superseded_v1_grant",
    "packages/work/src/context.ts",
    'validateDefinition("core", "Grant", grant);',
    "SUPERSEDED_CONTRACT_USE:packages/work/src/context.ts:Grant",
  ],
  [
    "superseded_billing_type_reference",
    "packages/policy/src/billing-state.ts",
    'import type { Billing_BillingAccount } from "@morrow/contracts";',
    "SUPERSEDED_CONTRACT_USE:packages/policy/src/billing-state.ts:BillingAccount",
  ],
  [
    "superseded_billing_validate_definition",
    "apps/api/src/index.ts",
    'validateDefinition("billing", "CreditGrant", value);',
    "SUPERSEDED_CONTRACT_USE:apps/api/src/index.ts:CreditGrant",
  ],
])
  negatives.push({
    name,
    passed: inspectSupersededUse(path, code, replaced, replacedBilling).includes(expected),
  });
for (const [name, path, code, expected] of [
  [
    "refined_validate_definition",
    "packages/work/src/events.ts",
    'validateDefinition("core-v1.1", "EventEnvelope", envelope);',
    "REFINED_DEFINITION_BYPASS:packages/work/src/events.ts:EventEnvelope",
  ],
  [
    "refined_selector",
    "apps/api/src/stream.ts",
    'const check = validators["core-v1.1:StreamFrame"];',
    "REFINED_DEFINITION_BYPASS:apps/api/src/stream.ts:StreamFrame",
  ],
  [
    "refined_admin_read_record",
    "packages/policy/src/collaboration.ts",
    'validateDefinition("core-v1.1", "AskAdminReadRecord", record);',
    "REFINED_DEFINITION_BYPASS:packages/policy/src/collaboration.ts:AskAdminReadRecord",
  ],
  // ADR-0022 item 2: the store rule (id = storeId) lives only in validateCurrentDefinition.
  [
    "refined_store_grant",
    "packages/policy/src/index.ts",
    'validateDefinition("core-v1.1", "Grant", grant);',
    "REFINED_DEFINITION_BYPASS:packages/policy/src/index.ts:Grant",
  ],
])
  negatives.push({ name, passed: inspectRefinedSelectorUse(path, code).includes(expected) });
// Planted registry deltas: a retyped row, a removed row, a row inserted before a
// pinned one, and an appended row that is not pinned.
const registryDelta = (change) => {
  const copy = structuredClone(registry);
  change(copy.events);
  return inspectEventRegistryBaseline(baseline, copy);
};
negatives.push(
  {
    name: "event_row_changed",
    passed: registryDelta((rows) => (rows[0].payloadDefinition = "EmptyEventPayload")).includes(
      "UNREVIEWED_EVENT_ROW_DELTA:" + registry.events[0].eventType,
    ),
  },
  {
    name: "event_row_removed",
    passed: registryDelta((rows) => rows.pop()).includes(
      "UNREVIEWED_EVENT_ROW_DELTA:" + registry.events.at(-1).eventType,
    ),
  },
  {
    name: "event_row_inserted",
    passed: registryDelta((rows) =>
      rows.splice(0, 0, { ...rows[0], eventType: "goal.archived" }),
    ).includes("UNREVIEWED_EVENT_ROW_DELTA:" + registry.events[0].eventType),
  },
  {
    name: "event_row_unpinned",
    passed: registryDelta((rows) => rows.push({ ...rows[0], eventType: "goal.archived" })).includes(
      "UNBASELINED_EVENT_ROW:goal.archived",
    ),
  },
);
for (const [name, code] of [
  ["entitlement_writer_literal_true", "const facts = { entitlementAllowed: true };"],
  ["entitlement_writer_variable", "const facts = { entitlementAllowed: allowed };"],
  ["entitlement_writer_assignment", "facts.entitlementAllowed = true;"],
  ["entitlement_writer_class_field", "class Facts { readonly entitlementAllowed = true; }"],
  [
    "entitlement_writer_parameter_property",
    "class Facts { constructor(readonly entitlementAllowed: boolean) {} }",
  ],
  [
    "entitlement_writer_aliased_key",
    'const key = "entitlementAllowed"; const facts = { [key]: true };',
  ],
  ["entitlement_writer_entries_pair", 'Object.fromEntries([["entitlementAllowed", true]]);'],
])
  negatives.push({
    name,
    passed: inspectEntitlementWriters("packages/work/src/permissions.ts", code).includes(
      "ENTITLEMENT_WRITER_UNAPPROVED:packages/work/src/permissions.ts:1",
    ),
  });
negatives.push({
  name: "phantom_replacement_declaration",
  passed: inspectDeclaredReplacements(
    { ...changes, changes: [...changes.changes, { ...changes.changes[0], name: "Invented" }] },
    layered,
  ).includes("UNDECLARED_REPLACEMENT:Invented"),
});
if (negatives.some((x) => !x.passed)) errors.push("Negative guard failed");
writeArtifact("verify/boundaries.json", {
  scope:
    "Source import/dependency and unreleased contract-freeze checks; not a security sandbox, production tenant authority or live runtime/provider qualification.",
  files: files.length,
  schema_files: schemaFiles.length,
  negative_checks: negatives,
  errors,
});
if (errors.length) throw Error(errors.join("\n"));
console.log(
  `PASS: ${files.length} source modules, ${schemaFiles.length} baselined schema files, ${negatives.length} deliberate boundary/schema failures detected.`,
);
