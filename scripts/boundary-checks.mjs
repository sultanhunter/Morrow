import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import {
  definitionLayers,
  bodyLayers,
  billingLayers,
  browserValidatorDefinitions,
} from "./contract-sources.mjs";
const root = resolve(".");
// Source organization checks for reviewed literal specifiers and recognized loaders.
// This is not hermetic: aliases, custom module resolution and transitive code need
// review; no execution isolation, authority or provider qualification is conferred.
const runtimeSdkFamilies = [
  ["daytona", /^@daytona\/sdk(?:\/|$)/],
  ["e2b", /^(?:e2b(?:\/|$)|@e2b\/)/],
  ["modal", /^(?:modal(?:\/|$)|@modal-labs[^/]*(?:\/|$))/],
  ["blaxel", /^@blaxel\//],
  ["sprites", /^@fly\/sprites(?:\/|$)/],
  ["cloudflare", /^@cloudflare\/sandbox(?:\/|$)/],
];
const adapterProvider = (path) =>
  /^packages\/runtime-adapters\/src\/(daytona|e2b|modal|blaxel|sprites|cloudflare)\//.exec(
    path,
  )?.[1];
const adapterPath = (path) => /^packages\/runtime-adapters(?:\/|$)/.test(path);
const compositionPath = "apps/workers/src/runtime-provider-composition.server.ts";
export function isBoundarySource(file) {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file);
}
const scriptKind = (file) =>
  file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(?:js|mjs|cjs)$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
const containsUnreviewedLoader = (node) => {
  if (ts.isIdentifier(node)) return node.text === "require";
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return containsUnreviewedLoader(node.expression);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const property = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
    return (
      containsUnreviewedLoader(node.expression) ||
      (property === "require" &&
        ts.isIdentifier(node.expression) &&
        ["module", "global", "globalThis"].includes(node.expression.text))
    );
  }
  if (ts.isCallExpression(node)) {
    // Consuming a module returned by direct require is ordinary use; its inner
    // call is inspected independently. This does not permit require wrappers.
    if (ts.isIdentifier(node.expression) && node.expression.text === "require") return false;
    return containsUnreviewedLoader(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken)
    return containsUnreviewedLoader(node.left) || containsUnreviewedLoader(node.right);
  return false;
};
export function inspectImports(file, code) {
  const errors = [];
  const path = relative(root, resolve(file)).replaceAll("\\", "/");
  const ui = /^(apps\/workspace-web\/src|packages\/workspace-ui\/src)\//.test(path);
  const neutral = /^packages\/(contracts|entry-ports)\/src\//.test(path);
  const runtimeCore = /^packages\/runtime\/src\//.test(path);
  const productionSource = /^(apps|packages)\//.test(path);
  const provider = adapterProvider(path);
  const composition = path === compositionPath;
  // The broker is trusted Worker source (ADR-0007): only it may import its own
  // modules, and it imports no other app.
  const broker = /^apps\/broker\//.test(path);
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
  const inspect = (specifier) => {
    let localTarget = null;
    try {
      const destination = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : isAbsolute(specifier)
          ? resolve(specifier)
          : specifier.startsWith("file:")
            ? fileURLToPath(specifier)
            : null;
      if (destination !== null) localTarget = relative(root, destination).replaceAll("\\", "/");
    } catch {
      errors.push("FILE_IMPORT_UNREVIEWED");
      return;
    }
    const installedPackage = (localTarget ?? specifier).split(/(?:^|\/)node_modules\//).at(-1);
    const sdkProvider = runtimeSdkFamilies.find(
      ([, pattern]) => pattern.test(specifier) || pattern.test(installedPackage),
    )?.[0];
    if (productionSource && sdkProvider && sdkProvider !== provider)
      errors.push("RUNTIME_SDK_OUTSIDE_ADAPTER");
    if (productionSource && /^(?:node:)?module(?:\/|$)/.test(specifier) && !provider)
      errors.push("RUNTIME_LOADER_OUTSIDE_ADAPTER");
    if (productionSource && /^@morrow\/runtime-adapters(?:\/|$)/.test(specifier) && !composition) {
      if (!provider) errors.push("RUNTIME_ADAPTER_IMPORT_DENIED");
      else if (
        /^@morrow\/runtime-adapters\/(daytona|e2b|modal|blaxel|sprites|cloudflare)(?:\/|$)/.exec(
          specifier,
        )?.[1] !== provider
      )
        errors.push("RUNTIME_ADAPTER_PROVIDER_MISMATCH");
    }
    if (
      runtimeCore &&
      specifier.startsWith("@morrow/") &&
      !/^@morrow\/(runtime|contracts|entry-ports)(?:\/|$)/.test(specifier)
    )
      errors.push("RUNTIME_CORE_DEPENDENCY_DENIED");
    if (
      ui &&
      !specifier.startsWith(".") &&
      ![
        "react",
        "react-dom/client",
        "@morrow/workspace-ui",
        "@morrow/workspace-ui/styles.css",
        "@morrow/contracts",
        "@morrow/contracts/routes",
        // Never the validator table (`/validation`, or `/client`, which imports it): only
        // the generated per-definition modules of the closed browser list (P05.T01y).
        ...browserValidatorDefinitions.map((name) => `@morrow/contracts/validators/${name}`),
        "@morrow/entry-ports",
      ].includes(specifier)
    )
      errors.push("UI_UNREVIEWED_DEPENDENCY");
    if (ui && (/^(@shopify\/|node:)/.test(specifier) || /\.server(\.|$)/.test(specifier)))
      errors.push("UI_SERVER_IMPORT");
    if (
      (ui || neutral) &&
      /^@morrow\/(api|broker|workers|shopify-connector|policy|identity|infrastructure|connectors|runtime|runtime-adapters|secrets|work)(\/|$)/.test(
        specifier,
      )
    )
      errors.push("TRUST_BOUNDARY_IMPORT");
    if (productionSource && !broker && /^@morrow\/broker(?:\/|$)/.test(specifier))
      errors.push("BROKER_SOURCE_IMPORT");
    if (localTarget !== null) {
      const target = localTarget;
      if (productionSource && !broker && /^apps\/broker\//.test(target))
        errors.push("BROKER_SOURCE_IMPORT");
      if (broker && /^apps\//.test(target) && !/^apps\/broker\//.test(target))
        errors.push("BROKER_APP_IMPORT");
      if (productionSource && adapterPath(target) && !composition) {
        if (!provider) errors.push("RUNTIME_ADAPTER_IMPORT_DENIED");
        else if (adapterProvider(target) !== provider)
          errors.push("RUNTIME_ADAPTER_PROVIDER_MISMATCH");
      }
      if (
        ui &&
        !/^(apps\/workspace-web\/src|packages\/(workspace-ui|contracts|entry-ports)\/src)\//.test(
          target,
        )
      )
        errors.push("UI_RELATIVE_ESCAPE");
      // Every spelling a bundler resolves to the table: any script extension (Bundler
      // resolution maps `.js` to `.ts`), a `?query` or `#hash` suffix, any letter case.
      if (
        ui &&
        /^packages\/contracts\/src\/(?:(?:validation|client)(?:\.[cm]?[jt]sx?)?$|generated\/runtime-validators)/i.test(
          target.replace(/[?#].*$/s, ""),
        )
      )
        errors.push("UI_VALIDATOR_TABLE_IMPORT");
      if (neutral && /^apps\//.test(target)) errors.push("NEUTRAL_APP_IMPORT");
      if (neutral && !/^packages\/(contracts|entry-ports)\/src\//.test(target))
        errors.push("NEUTRAL_RELATIVE_ESCAPE");
      if (runtimeCore && !/^packages\/(runtime|contracts|entry-ports)\/src\//.test(target))
        errors.push("RUNTIME_CORE_RELATIVE_ESCAPE");
      if (ui && /\.server(\.|$)/.test(target)) errors.push("UI_SERVER_IMPORT");
      // P14.T01a §4.11 (a): fixture code is reachable only from the fixture entry.
      if (
        /^apps\/workspace-web\/src\/fixtures\//.test(target) &&
        /^(apps|packages)\//.test(path) &&
        path !== "apps/workspace-web/src/fixture-main.tsx" &&
        !/^apps\/workspace-web\/src\/fixtures\//.test(path)
      )
        errors.push("UI_FIXTURE_IMPORT");
    }
  };
  const inspectLiteral = (node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
      inspect(node.text);
    else errors.push("DYNAMIC_IMPORT_UNREVIEWED");
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        inspect(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node))
      inspectLiteral(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      inspectLiteral(node.moduleReference.expression);
    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
        inspectLiteral(node.arguments[0]);
      else if (containsUnreviewedLoader(node.expression)) errors.push("MODULE_LOADER_UNREVIEWED");
    }
    if (ui && ts.isIdentifier(node) && node.text === "process")
      errors.push("UI_SERVER_ENVIRONMENT");
    if (ui) inspectUiSinks(node, path, errors);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(errors)];
}
// P14.T01a §5: UI source renders text only and keeps browser state to the two
// reviewed sessionStorage owners. No HTML sinks, cookies, dynamic code or localStorage.
const htmlSinks = new Set([
  "dangerouslySetInnerHTML",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
]);
const sessionStorageOwners = new Set([
  "apps/workspace-web/src/intended-route.ts",
  "apps/workspace-web/src/pending.ts",
]);
function inspectUiSinks(node, path, errors) {
  const name = ts.isIdentifier(node)
    ? node.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : null;
  if (name !== null) {
    if (htmlSinks.has(name)) errors.push("UI_HTML_SINK");
    if (name === "eval") errors.push("UI_DYNAMIC_CODE");
    if (name === "localStorage") errors.push("UI_LOCAL_STORAGE");
    if (name === "sessionStorage" && !sessionStorageOwners.has(path))
      errors.push("UI_SESSION_STORAGE_OUTSIDE_OWNER");
  }
  if (ts.isJsxAttribute(node) && htmlSinks.has(node.name.getText())) errors.push("UI_HTML_SINK");
  if (
    (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Function"
  )
    errors.push("UI_DYNAMIC_CODE");
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "document"
  ) {
    const member = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
    if (member === "cookie") errors.push("UI_COOKIE_ACCESS");
    if (member === "write" || member === "writeln") errors.push("UI_HTML_SINK");
  }
}
export function inspectCompatibility(baseline, schemas) {
  return Object.entries(baseline.schemas)
    .filter(
      ([path, digest]) =>
        !schemas[path] || createHash("sha256").update(schemas[path]).digest("hex") !== digest,
    )
    .map(([path]) => "UNREVIEWED_SCHEMA_DELTA:" + path);
}
// Every schema file under docs/contracts/schemas must be hashed in the
// baseline; otherwise a new file escapes inspectCompatibility.
export function inspectBaselineCoverage(baseline, schemaPaths) {
  return schemaPaths
    .filter(
      (path) =>
        /^docs\/contracts\/schemas\/.+\.schema\.json$/.test(path) &&
        !Object.hasOwn(baseline.schemas, path),
    )
    .map((path) => "UNBASELINED_SCHEMA:" + path);
}
// The event registry (ADR-0016 item 6) is append-only: the baseline pins each
// row by the SHA-256 of its JCS form, in registry order. A changed, removed or
// reordered row is a replacement (events.md: an ADR and a deliberate baseline
// edit), and a new row must be appended after the pinned ones and pinned too.
export const eventRowDigest = (row) => createHash("sha256").update(canonicalize(row)).digest("hex");
export function inspectEventRegistryBaseline(baseline, registry) {
  const pinned = baseline?.event_registry?.rows;
  if (!pinned || typeof pinned !== "object" || Array.isArray(pinned))
    return ["UNBASELINED_EVENT_REGISTRY"];
  const rows = Array.isArray(registry?.events) ? registry.events : [];
  const errors = [];
  const types = Object.keys(pinned);
  types.forEach((type, i) => {
    const row = rows[i];
    if (!row || row.eventType !== type || eventRowDigest(row) !== pinned[type])
      errors.push("UNREVIEWED_EVENT_ROW_DELTA:" + type);
  });
  for (const row of rows.slice(types.length))
    errors.push("UNBASELINED_EVENT_ROW:" + (row?.eventType ?? JSON.stringify(row)));
  return errors;
}
// A newest-layer definition (core or billing) that reuses an older name, or a
// newest-layer capability body that overrides an older body, is a replacement:
// it must be declared in changes.json, and every declaration must name a real
// replacement. `schemas` maps source kinds (contract-sources.mjs) to parsed schemas.
export function inspectDeclaredReplacements(changes, schemas) {
  const layers = {
    definition: definitionLayers,
    capability_body: bodyLayers,
    billing_definition: billingLayers,
  };
  const replaced = (kind, name) =>
    layers[kind].slice(1).find((older) => Object.hasOwn(schemas[older].$defs, name));
  const errors = [],
    declared = new Set();
  const entries = Array.isArray(changes?.changes) ? changes.changes : [];
  if (!Array.isArray(changes?.changes)) errors.push("UNDECLARED_REPLACEMENT:changes.json");
  for (const entry of entries) {
    const name = typeof entry?.name === "string" ? entry.name : JSON.stringify(entry?.name);
    const valid =
      entry !== null &&
      typeof entry === "object" &&
      Object.keys(entry).sort().join() === "adr,kind,name,reason,replaces" &&
      Object.hasOwn(layers, entry.kind) &&
      typeof entry.name === "string" &&
      Object.hasOwn(schemas[layers[entry.kind][0]].$defs, entry.name) &&
      replaced(entry.kind, entry.name) !== undefined &&
      entry.replaces === `${replaced(entry.kind, entry.name)}:${entry.name}` &&
      typeof entry.reason === "string" &&
      entry.reason.trim() !== "" &&
      /^ADR-\d{4}$/.test(entry.adr) &&
      !declared.has(entry.kind + ":" + entry.name);
    if (valid) declared.add(entry.kind + ":" + entry.name);
    else errors.push("UNDECLARED_REPLACEMENT:" + name);
  }
  for (const [kind, [newest]] of Object.entries(layers))
    for (const name of Object.keys(schemas[newest].$defs))
      if (replaced(kind, name) && !declared.has(kind + ":" + name))
        errors.push("UNDECLARED_REPLACEMENT:" + name);
  return [...new Set(errors)];
}
const replacedNames = (changes, kind) =>
  (Array.isArray(changes?.changes) ? changes.changes : [])
    .filter((entry) => entry?.kind === kind && typeof entry.name === "string")
    .map((entry) => entry.name);
// Names of the core definitions changes.json declares replaced (Proposal,
// Approval, and later T02b/T02c replacements such as Evidence@2).
export const replacedDefinitionNames = (changes) => replacedNames(changes, "definition");
// Names of the billing definitions changes.json declares replaced (ADR-0015:
// BillingAccount, EntitlementSnapshot, CreditGrant, AllocationShare, CostAllocation).
export const replacedBillingDefinitionNames = (changes) =>
  replacedNames(changes, "billing_definition");
// Generated files define every exact selector and type, replaced ones included.
const generatedContracts = /^packages\/contracts\/src\/generated\//;
// EventEnvelope@2, the StreamFrame carrying it and AskAdminReadRecord have code
// rules beyond their schemas (the event registry, the payloadRef binding, the
// admin-read reader and uniqueness rules), applied only by
// `validateCurrentDefinition` in packages/contracts/src/validation.ts. Product
// code under apps/ and packages/ never validates them by their exact v1.1
// selector: a `"core-v1.1:<name>"` literal or `validateDefinition("core-v1.1", <name>)`.
export const refinedDefinitionNames = Object.freeze([
  "AskAdminReadRecord",
  "EventEnvelope",
  "StreamFrame",
]);
export function inspectRefinedSelectorUse(file, code) {
  const path = relative(root, resolve(file)).replaceAll("\\", "/");
  if (!/^(apps|packages)\//.test(path) || generatedContracts.test(path)) return [];
  const names = new Set(refinedDefinitionNames);
  const found = new Set();
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
  const visit = (node) => {
    const text = literal(node);
    if (text?.startsWith("core-v1.1:") && names.has(text.slice(10))) found.add(text.slice(10));
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      const name = literal(node.arguments[1]);
      if (
        callee === "validateDefinition" &&
        literal(node.arguments[0]) === "core-v1.1" &&
        name !== null &&
        names.has(name)
      )
        found.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort().map((name) => `REFINED_DEFINITION_BYPASS:${path}:${name}`);
}
// Product code under apps/ and packages/ must not validate or type a replaced v1
// definition: `validateDefinition("core", <replaced>)`, a `"core:<replaced>"`
// selector or a `Core_<replaced>` type, and likewise `"billing"`, `"billing:"` and
// `Billing_` for a replaced billing definition. It uses the effective selectors.
export function inspectSupersededUse(file, code, replaced, replacedBilling = []) {
  const path = relative(root, resolve(file)).replaceAll("\\", "/");
  if (!/^(apps|packages)\//.test(path) || generatedContracts.test(path)) return [];
  const layers = [
    ["core", "Core_", new Set(replaced)],
    ["billing", "Billing_", new Set(replacedBilling)],
  ];
  const found = new Set();
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
  const visit = (node) => {
    const text = literal(node);
    for (const [schema, prefix, names] of layers) {
      if (
        ts.isIdentifier(node) &&
        node.text.startsWith(prefix) &&
        names.has(node.text.slice(prefix.length))
      )
        found.add(node.text.slice(prefix.length));
      if (text?.startsWith(schema + ":") && names.has(text.slice(schema.length + 1)))
        found.add(text.slice(schema.length + 1));
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      const name = literal(node.arguments[1]);
      const layer = layers.find(([schema]) => schema === literal(node.arguments[0]));
      if (callee === "validateDefinition" && layer && name !== null && layer[2].has(name))
        found.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort().map((name) => `SUPERSEDED_CONTRACT_USE:${path}:${name}`);
}

// P01.T04a §2: `entitlementAllowed` is set only by the billing constraints reader
// and the two forwarders that copy a CurrentConstraintsReader result. Every other
// product builder under apps/ and packages/ passes a literal `false`, which the
// evaluators read only for paid work. A P05.T04b agent reader adds its function
// here in its own reviewed PR. A write is an object property, shorthand, getter
// or method; a class field or constructor parameter property; an assignment
// through `.`, `[]` or a logical-assignment operator; a `defineProperty`/`set`
// call; or an entries pair such as `Object.fromEntries([[key, value]])`. The key
// may be written directly, as a string, or through a variable bound to the
// field's name, and a computed key that is not a literal is a write when its
// object or class also declares `providerAllowed`. Type declarations are not
// writes; tests/ and scripts/ are out of scope, as are `*.test.*` files. Not
// hermetic: a spread, or a value copied through an untyped helper or an opaque
// key, needs review; createWorkspacePermissionBoundary also accepts only a plain
// closed boolean pair from a CurrentConstraintsReader.
export const entitlementWriterAllowlist = Object.freeze({
  "packages/policy/src/billing-state.ts": Object.freeze(["createBillingConstraintsReader"]),
  "packages/policy/src/index.ts": Object.freeze([
    "createHumanPolicyService",
    "createWorkspacePermissionBoundary",
  ]),
});
const entitlementField = "entitlementAllowed";
export function inspectEntitlementWriters(file, code) {
  const path = relative(root, resolve(file)).replaceAll("\\", "/");
  if (
    !/^(apps|packages)\//.test(path) ||
    generatedContracts.test(path) ||
    /\.test\.[cm]?[jt]sx?$/.test(path)
  )
    return [];
  const allowed = entitlementWriterAllowlist[path] ?? [];
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
  const errors = [];
  const strip = (node) => {
    while (
      node &&
      (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node))
    )
      node = node.expression;
    return node;
  };
  const stringText = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const nameText = (name) =>
    ts.isIdentifier(name)
      ? name.text
      : ts.isComputedPropertyName(name)
        ? stringText(name.expression)
        : stringText(name);
  const literalFalse = (node) => strip(node)?.kind === ts.SyntaxKind.FalseKeyword;
  // Names bound to the field's string anywhere in the file, so that
  // `const k = "entitlementAllowed"; f[k] = true` is a write too.
  const aliases = new Set();
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      stringText(strip(node.initializer)) === entitlementField
    )
      aliases.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const isKey = (node) => {
    const key = strip(node);
    return (
      stringText(key) === entitlementField ||
      (!!key && ts.isIdentifier(key) && aliases.has(key.text))
    );
  };
  const nameIs = (name) =>
    ts.isComputedPropertyName(name) ? isKey(name.expression) : nameText(name) === entitlementField;
  // A computed key that is not a literal, in an object or class that also
  // declares `providerAllowed`, may name the field and counts as a write.
  const opaqueBesideProvider = (node) => {
    if (!ts.isComputedPropertyName(node.name)) return false;
    const key = strip(node.name.expression);
    if (stringText(key) !== null || ts.isNumericLiteral(key)) return false;
    const container = node.parent;
    const members = ts.isObjectLiteralExpression(container)
      ? container.properties
      : ts.isClassLike(container)
        ? container.members
        : [];
    return members.some(
      (member) =>
        member.name &&
        !ts.isComputedPropertyName(member.name) &&
        nameText(member.name) === "providerAllowed",
    );
  };
  const functionName = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name)
      return nameText(node.name);
    if (
      (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    )
      return node.parent.name.text;
    return null;
  };
  const insideAllowed = (node) => {
    for (let n = node.parent; n; n = n.parent) if (allowed.includes(functionName(n))) return true;
    return false;
  };
  const write = (node, value) => {
    if ((value === null || !literalFalse(value)) && !insideAllowed(node))
      errors.push(
        `ENTITLEMENT_WRITER_UNAPPROVED:${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
      );
  };
  const assignment = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ]);
  const calleeName = (expression) =>
    ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : null;
  const visit = (node) => {
    if (
      (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
      (nameIs(node.name) || opaqueBesideProvider(node))
    )
      // A class field with no initializer is flagged too.
      write(node, node.initializer ?? null);
    else if (
      (ts.isShorthandPropertyAssignment(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isMethodDeclaration(node)) &&
      (nameIs(node.name) || opaqueBesideProvider(node))
    )
      write(node, null);
    else if (
      ts.isParameter(node) &&
      ts.isParameterPropertyDeclaration(node, node.parent) &&
      ts.isIdentifier(node.name) &&
      node.name.text === entitlementField
    )
      write(node, null);
    else if (
      ts.isBinaryExpression(node) &&
      assignment.has(node.operatorToken.kind) &&
      ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === entitlementField) ||
        (ts.isElementAccessExpression(node.left) && isKey(node.left.argumentExpression)))
    )
      write(node, node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : null);
    else if (
      ts.isCallExpression(node) &&
      ["defineProperty", "set"].includes(calleeName(node.expression)) &&
      node.arguments.some(isKey)
    )
      write(node, null);
    else if (
      ts.isArrayLiteralExpression(node) &&
      ts.isArrayLiteralExpression(node.parent) &&
      node.elements.length > 0 &&
      isKey(node.elements[0])
    )
      // An entries pair: Object.fromEntries([[key, value]]), new Map([[key, value]]).
      write(node, node.elements[1] ?? null);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}
