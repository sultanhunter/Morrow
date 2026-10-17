import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectImports,
  inspectCompatibility,
  isBoundarySource,
} from "../scripts/boundary-checks.mjs";
import {
  validateDefinition,
  validateCapabilityInput,
} from "../packages/contracts/src/validation.ts";
import { createCapabilityClient } from "../packages/contracts/src/client.ts";
const input = {
  objective: "Investigate",
  storeIds: ["demo"],
  successCriteria: [
    { description: "Evidence", verificationCapabilityId: null, evidenceRequired: true },
  ],
};
test("generated client validates a real input/output pair", async () => {
  const client = createCapabilityClient(async () => ({ goalId: "goal", revision: 1 }));
  assert.deepEqual(await client.invoke("workspace.goal.create", input), {
    goalId: "goal",
    revision: 1,
  });
});
test("extra input cannot reach transport", async () => {
  let calls = 0;
  const client = createCapabilityClient(async () => {
    calls++;
  });
  await assert.rejects(
    client.invoke("workspace.goal.create", { ...input, shop: "forged" }),
    /Invalid capability input/,
  );
  assert.equal(calls, 0);
});
test("provider output is not accepted on static types alone", async () => {
  const client = createCapabilityClient(async () => ({ goalId: "goal", revision: "1" }));
  await assert.rejects(client.invoke("workspace.goal.create", input), /Invalid capability output/);
});
test("the client sends the effective v1.1 kill-switch body and refuses the replaced v1 body", async () => {
  const ref = {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    kind: "proposal",
    id: "proposal_a",
    revision: 1,
    digest: "a".repeat(64),
  };
  const sent = [];
  const client = createCapabilityClient(async (id, body) => {
    sent.push([id, body]);
    return {
      operationId: "operation_a",
      readback: { ...ref, kind: "evidence", id: "evidence_a" },
    };
  });
  const pause = {
    campaigns: [
      {
        organizationId: "org_a",
        workspaceId: "workspace_a",
        storeId: "store_a",
        connectionId: "connection_a",
        kind: "campaign",
        id: "campaign_a",
      },
    ],
    control: { reason: "Overspend", sourceProposalRef: ref },
  };
  assert.equal((await client.invoke("ads.campaign.pause", pause)).operationId, "operation_a");
  await assert.rejects(
    client.invoke("ads.campaign.pause", {
      proposalRef: ref,
      approvalRef: { ...ref, kind: "approval" },
    }),
    /Invalid capability input/,
  );
  assert.deepEqual(sent, [["ads.campaign.pause", pause]]);
});
test("closed input validation does not coerce", () =>
  assert.equal(
    validateCapabilityInput("workspace.goal.create", { ...input, objective: 42 }),
    false,
  ));
for (const [value, expected] of [
  [1, true],
  [1.2, false],
  ["1", false],
  [Number.MAX_SAFE_INTEGER + 1, false],
])
  test("runtime revision " + String(value), () =>
    assert.equal(validateDefinition("core", "Revision", value), expected),
  );
for (const code of [
  "import x from '@shopify/shopify-app-react-router/server'",
  "export {x} from './credentials.server'",
  "import x from '../../api/src/index'",
  "const x=import(secretModule)",
  "const x=process['env']['KEY']",
  "import fs from 'fs'",
])
  test("deny UI crossing: " + code, () =>
    assert.ok(inspectImports("apps/workspace-web/src/test.tsx", code).length > 0),
  );
test("ordinary shared UI imports allowed", () =>
  assert.deepEqual(
    inspectImports(
      "apps/workspace-web/src/test.tsx",
      "import {FoundationNotice} from '@morrow/workspace-ui'",
    ),
    [],
  ));
test("neutral contracts cannot depend on app implementations", () =>
  assert.ok(
    inspectImports(
      "packages/contracts/src/index.ts",
      "export {x} from '../../../apps/api/src/index'",
    ).length > 0,
  ));
for (const [provider, specifiers] of [
  ["daytona", ["@daytona/sdk", "@daytona/sdk/api"]],
  ["e2b", ["e2b", "@e2b/code-interpreter"]],
  ["modal", ["modal", "@modal-labs/sdk", "@modal-labs-extra/sdk"]],
  ["blaxel", ["@blaxel/core"]],
  ["sprites", ["@fly/sprites"]],
  ["cloudflare", ["@cloudflare/sandbox"]],
])
  test(`${provider} SDK imports require their dedicated server adapter`, () => {
    for (const specifier of specifiers) {
      const code = `import {Client} from '${specifier}';`;
      assert.deepEqual(
        inspectImports(`packages/runtime-adapters/src/${provider}/client.ts`, code),
        [],
      );
      for (const path of [
        "packages/runtime/src/harness.ts",
        "packages/contracts/src/index.ts",
        "packages/entry-ports/src/index.ts",
        "packages/policy/src/index.ts",
        "packages/identity/src/index.ts",
        "packages/connectors/src/index.ts",
        "packages/infrastructure/src/index.ts",
        "apps/api/src/routes/runtime.ts",
        "apps/workers/src/index.ts",
        `apps/workspace-web/src/runtime-adapters/${provider}/client.ts`,
        "packages/runtime-adapters/src/index.ts",
        `packages/runtime-adapters/src/${provider === "daytona" ? "e2b" : "daytona"}/client.ts`,
      ])
        assert.ok(inspectImports(path, code).includes("RUNTIME_SDK_OUTSIDE_ADAPTER"), path);
    }
  });
test("all reviewed TypeScript module syntax obeys the runtime SDK boundary", () => {
  for (const code of [
    "import {Client} from '@daytona/sdk';",
    "import type {Client} from '@daytona/sdk';",
    "export {Client} from '@daytona/sdk';",
    "export * from '@daytona/sdk';",
    "const client = import('@daytona/sdk');",
    "const client = require('@daytona/sdk');",
    "const client = require(`@daytona/sdk`);",
    "type Client = import('@daytona/sdk').Client;",
    "import Client = require('@daytona/sdk');",
  ]) {
    assert.ok(
      inspectImports("packages/runtime/src/harness.ts", code).includes(
        "RUNTIME_SDK_OUTSIDE_ADAPTER",
      ),
      code,
    );
    assert.deepEqual(inspectImports("packages/runtime-adapters/src/daytona/client.ts", code), []);
  }
});
test("relative node_modules paths cannot bypass the runtime SDK boundary", () => {
  for (const path of ["packages/runtime/src/harness.ts", "packages/identity/src/index.ts"])
    assert.ok(
      inspectImports(path, "import {Client} from '../../../node_modules/@daytona/sdk';").includes(
        "RUNTIME_SDK_OUTSIDE_ADAPTER",
      ),
    );
});
test("core and application modules cannot import adapters by alias or relative escape", () => {
  for (const [path, code] of [
    ["packages/contracts/src/index.ts", "import {x} from '@morrow/runtime-adapters/daytona';"],
    ["packages/runtime/src/harness.ts", "type X = import('@morrow/runtime-adapters').X;"],
    ["packages/policy/src/index.ts", "export {x} from '../../runtime-adapters/src/e2b/client';"],
    ["apps/api/src/index.ts", "import X = require('@morrow/runtime-adapters/daytona');"],
    ["apps/workers/src/index.ts", "const x = import('../../../packages/runtime-adapters');"],
  ])
    assert.ok(inspectImports(path, code).includes("RUNTIME_ADAPTER_IMPORT_DENIED"), code);
});
test("neutral and runtime core relative imports stay within reviewed shared packages", () => {
  for (const [path, code, expected] of [
    [
      "packages/contracts/src/index.ts",
      "export {x} from '../../identity/src/index';",
      "NEUTRAL_RELATIVE_ESCAPE",
    ],
    [
      "packages/runtime/src/harness.ts",
      "export {x} from '../../../apps/workers/src/index';",
      "RUNTIME_CORE_RELATIVE_ESCAPE",
    ],
  ])
    assert.ok(inspectImports(path, code).includes(expected), code);
  assert.deepEqual(
    inspectImports(
      "packages/runtime/src/harness.ts",
      "import type {Run} from '@morrow/contracts'; import type {Run as R} from '../../contracts/src/index'; export {x} from './leases';",
    ),
    [],
  );
});
test("only the planned worker composition seam can import adapters directly", () => {
  const path = "apps/workers/src/runtime-provider-composition.server.ts";
  for (const code of [
    "import {createProvider} from '@morrow/runtime-adapters/daytona';",
    "import {createProvider} from '../../../packages/runtime-adapters/src/e2b/client';",
  ])
    assert.deepEqual(inspectImports(path, code), []);
  assert.ok(
    inspectImports(path, "import {Daytona} from '@daytona/sdk';").includes(
      "RUNTIME_SDK_OUTSIDE_ADAPTER",
    ),
  );
  assert.ok(
    inspectImports(
      "apps/workspace-web/src/runtime-provider-composition.server.ts",
      "import {createProvider} from '@morrow/runtime-adapters/daytona';",
    ).includes("RUNTIME_ADAPTER_IMPORT_DENIED"),
  );
});
test("computed module loads are denied even within a dedicated adapter", () => {
  for (const code of [
    "const x = import(moduleName);",
    "const x = require('@daytona/' + moduleName);",
    "const x = import(`@daytona/${moduleName}`);",
  ])
    assert.ok(
      inspectImports("packages/runtime-adapters/src/daytona/client.ts", code).includes(
        "DYNAMIC_IMPORT_UNREVIEWED",
      ),
    );
});
test("wrapper and module loaders cannot bypass reviewed literal loads", () => {
  for (const code of [
    "const x = require.call(null, 'e2b');",
    "const x = require.apply(null, ['e2b']);",
    "const x = require['call'](null, 'e2b');",
    "const x = module.require('e2b');",
    "const x = module['require']('e2b');",
    "const x = (require)('e2b');",
    "const x = (0, require)('e2b');",
    "const x = (require as Function)('e2b');",
    "const x = require.bind(null)('e2b');",
  ])
    for (const path of [
      "packages/runtime/src/harness.ts",
      "packages/runtime-adapters/src/e2b/client.ts",
    ])
      assert.ok(inspectImports(path, code).includes("MODULE_LOADER_UNREVIEWED"), code);
});
test("ordinary use of a reviewed require result is allowed only in its adapter", () => {
  for (const code of [
    "const client = require('@daytona/sdk').createClient();",
    "const client = require('@daytona/sdk')();",
    "const client = (require('@daytona/sdk')).createClient();",
  ]) {
    assert.deepEqual(inspectImports("packages/runtime-adapters/src/daytona/client.ts", code), []);
    assert.ok(
      inspectImports("packages/runtime/src/harness.ts", code).includes(
        "RUNTIME_SDK_OUTSIDE_ADAPTER",
      ),
    );
  }
  assert.ok(
    inspectImports(
      "packages/runtime-adapters/src/daytona/client.ts",
      "require(moduleName)();",
    ).includes("DYNAMIC_IMPORT_UNREVIEWED"),
  );
});
test("absolute paths and local file URLs cannot bypass direct adapter boundaries", () => {
  const target = resolve("packages/runtime-adapters/src/e2b/client.ts");
  for (const specifier of [target, pathToFileURL(target).href])
    for (const path of ["apps/api/src/index.ts", "packages/runtime/src/harness.ts"])
      assert.ok(
        inspectImports(path, `import {createProvider} from ${JSON.stringify(specifier)};`).includes(
          "RUNTIME_ADAPTER_IMPORT_DENIED",
        ),
      );
  assert.ok(
    inspectImports(
      "packages/runtime/src/harness.ts",
      "import x from 'file://foreign-host/private.mjs';",
    ).includes("FILE_IMPORT_UNREVIEWED"),
  );
});
test("custom Node loaders are confined to dedicated adapters", () => {
  for (const specifier of ["node:module", "module"])
    for (const code of [
      `import {createRequire} from '${specifier}';`,
      `const x = import('${specifier}');`,
      `const x = require('${specifier}');`,
      `type X = import('${specifier}').Module;`,
    ]) {
      for (const path of [
        "packages/runtime/src/harness.ts",
        "packages/contracts/src/index.ts",
        "packages/policy/src/index.ts",
        "apps/workers/src/runtime-provider-composition.server.ts",
      ])
        assert.ok(inspectImports(path, code).includes("RUNTIME_LOADER_OUTSIDE_ADAPTER"), code);
      assert.deepEqual(inspectImports("packages/runtime-adapters/src/e2b/client.ts", code), []);
    }
});
test("runtime core alias imports have the same shared-package limits as relative imports", () => {
  for (const specifier of [
    "@morrow/workers/runtime-provider-composition.server",
    "@morrow/identity",
    "@morrow/policy",
    "@morrow/runtime-adapters/daytona",
  ])
    assert.ok(
      inspectImports("packages/runtime/src/harness.ts", `import {x} from '${specifier}';`).includes(
        "RUNTIME_CORE_DEPENDENCY_DENIED",
      ),
    );
  for (const specifier of ["@morrow/runtime/leases", "@morrow/contracts", "@morrow/entry-ports"])
    assert.deepEqual(
      inspectImports("packages/runtime/src/harness.ts", `import type {X} from '${specifier}';`),
      [],
    );
});
test("provider adapters cannot choose sibling adapters or root aggregators", () => {
  const path = "packages/runtime-adapters/src/daytona/client.ts";
  for (const specifier of [
    "@morrow/runtime-adapters/e2b",
    "@morrow/runtime-adapters",
    "../e2b/client",
    "../shared/helper",
    "../index",
  ])
    assert.ok(
      inspectImports(path, `import {x} from '${specifier}';`).includes(
        "RUNTIME_ADAPTER_PROVIDER_MISMATCH",
      ),
      specifier,
    );
  for (const specifier of [
    "@morrow/runtime-adapters/daytona/types",
    "./types",
    "@morrow/runtime",
    "@morrow/contracts",
  ])
    assert.deepEqual(inspectImports(path, `import type {X} from '${specifier}';`), []);
});
test("all reviewed JS and TS module extensions participate in SDK boundary checks", () => {
  for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
    const path = `packages/runtime/src/harness.${extension}`;
    assert.equal(isBoundarySource(path), true);
    assert.ok(
      inspectImports(path, "import {Client} from 'e2b';").includes("RUNTIME_SDK_OUTSIDE_ADAPTER"),
    );
  }
  for (const path of ["package.json", "diagram.svg", "source.ts.map", "snapshot.mjs.txt"])
    assert.equal(isBoundarySource(path), false);
  for (const extension of ["tsx", "jsx"])
    assert.ok(
      inspectImports(
        `apps/workspace-web/src/impostor.${extension}`,
        "import {Client} from 'e2b'; const view = <div />;",
      ).includes("RUNTIME_SDK_OUTSIDE_ADAPTER"),
    );
});
test("incompatible schema delta blocks before baseline rewrite", () => {
  const baseline = JSON.parse(readFileSync("docs/contracts/release-baseline.json", "utf8"));
  const sources = Object.fromEntries(
    Object.keys(baseline.schemas).map((p) => [p, readFileSync(p, "utf8")]),
  );
  assert.deepEqual(inspectCompatibility(baseline, sources), []);
  const path = Object.keys(sources)[0],
    schema = JSON.parse(sources[path]);
  schema.$defs.Id.type = "number";
  sources[path] = JSON.stringify(schema);
  assert.equal(inspectCompatibility(baseline, sources).length, 1);
});
