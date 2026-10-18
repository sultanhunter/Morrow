import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { definitionLayers, bodyLayers } from "./contract-sources.mjs";
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
        "@morrow/contracts",
        "@morrow/contracts/client",
        "@morrow/contracts/validation",
        "@morrow/entry-ports",
      ].includes(specifier)
    )
      errors.push("UI_UNREVIEWED_DEPENDENCY");
    if (ui && (/^(@shopify\/|node:)/.test(specifier) || /\.server(\.|$)/.test(specifier)))
      errors.push("UI_SERVER_IMPORT");
    if (
      (ui || neutral) &&
      /^@morrow\/(api|broker|workers|shopify-connector|policy|identity|infrastructure|connectors|runtime|runtime-adapters|secrets)(\/|$)/.test(
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
      if (neutral && /^apps\//.test(target)) errors.push("NEUTRAL_APP_IMPORT");
      if (neutral && !/^packages\/(contracts|entry-ports)\/src\//.test(target))
        errors.push("NEUTRAL_RELATIVE_ESCAPE");
      if (runtimeCore && !/^packages\/(runtime|contracts|entry-ports)\/src\//.test(target))
        errors.push("RUNTIME_CORE_RELATIVE_ESCAPE");
      if (ui && /\.server(\.|$)/.test(target)) errors.push("UI_SERVER_IMPORT");
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
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(errors)];
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
// A newest-layer definition that reuses an older name, or a newest-layer
// capability body that overrides an older body, is a replacement: it must be
// declared in changes.json, and every declaration must name a real replacement.
// `schemas` maps source kinds (contract-sources.mjs) to parsed schemas.
export function inspectDeclaredReplacements(changes, schemas) {
  const layers = { definition: definitionLayers, capability_body: bodyLayers };
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
// Names of the core definitions changes.json declares replaced (Proposal,
// Approval, and later T02b/T02c replacements such as Evidence@2).
export const replacedDefinitionNames = (changes) =>
  (Array.isArray(changes?.changes) ? changes.changes : [])
    .filter((entry) => entry?.kind === "definition" && typeof entry.name === "string")
    .map((entry) => entry.name);
// Generated files define every exact selector and type, replaced ones included.
const generatedContracts = /^packages\/contracts\/src\/generated\//;
// Product code under apps/ and packages/ must not validate or type a replaced v1
// definition: `validateDefinition("core", <replaced>)`, a `"core:<replaced>"`
// selector or a `Core_<replaced>` type. It uses the effective (current) selectors.
export function inspectSupersededUse(file, code, replaced) {
  const path = relative(root, resolve(file)).replaceAll("\\", "/");
  if (!/^(apps|packages)\//.test(path) || generatedContracts.test(path)) return [];
  const names = new Set(replaced);
  const found = new Set();
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text.startsWith("Core_") && names.has(node.text.slice(5)))
      found.add(node.text.slice(5));
    const text = literal(node);
    if (text?.startsWith("core:") && names.has(text.slice(5))) found.add(text.slice(5));
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      const name = literal(node.arguments[1]);
      if (
        callee === "validateDefinition" &&
        literal(node.arguments[0]) === "core" &&
        name !== null &&
        names.has(name)
      )
        found.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort().map((name) => `SUPERSEDED_CONTRACT_USE:${path}:${name}`);
}
