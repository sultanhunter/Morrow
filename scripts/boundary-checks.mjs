import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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
      /^@morrow\/(api|workers|shopify-connector|policy|identity|infrastructure|connectors|runtime|runtime-adapters|secrets)(\/|$)/.test(
        specifier,
      )
    )
      errors.push("TRUST_BOUNDARY_IMPORT");
    if (localTarget !== null) {
      const target = localTarget;
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
