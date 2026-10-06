import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(".");
export function inspectImports(file, code) {
  const errors = [];
  const path = relative(root, resolve(file)).replaceAll("\\", "/");
  const ui = /^(apps\/workspace-web\/src|packages\/workspace-ui\/src)\//.test(path);
  const neutral = /^packages\/(contracts|entry-ports)\/src\//.test(path);
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const inspect = (specifier) => {
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
      /^@morrow\/(api|workers|shopify-connector|policy|connectors|runtime|secrets)(\/|$)/.test(
        specifier,
      )
    )
      errors.push("TRUST_BOUNDARY_IMPORT");
    if (specifier.startsWith(".")) {
      const target = relative(root, resolve(dirname(file), specifier)).replaceAll("\\", "/");
      if (
        ui &&
        !/^(apps\/workspace-web\/src|packages\/(workspace-ui|contracts|entry-ports)\/src)\//.test(
          target,
        )
      )
        errors.push("UI_RELATIVE_ESCAPE");
      if (neutral && /^apps\//.test(target)) errors.push("NEUTRAL_APP_IMPORT");
      if (ui && /\.server(\.|$)/.test(target)) errors.push("UI_SERVER_IMPORT");
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        inspect(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === "require")
    ) {
      const a = node.arguments[0];
      if (!a || !ts.isStringLiteral(a)) errors.push("DYNAMIC_IMPORT_UNREVIEWED");
      else inspect(a.text);
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
