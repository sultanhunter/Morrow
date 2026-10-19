import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import {
  contractVersion,
  readSchemaSources,
  repositoryRoot,
  schemasByKind,
  currentDefinitionSelectors,
  currentBillingDefinitionSelectors,
  capabilityBodySelectors,
  browserValidatorDefinitions,
} from "./contract-sources.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export const validatorsPath = "packages/contracts/src/generated/runtime-validators.mjs";
export const validatorsManifestPath = "packages/contracts/src/generated/runtime-validators.json";
export const validatorsTypesPath = "packages/contracts/src/generated/runtime-validators.d.mts";
// One module per browser definition, `@morrow/contracts/validators/<Name>` (P05.T01y).
// Owned by this generator: a file here that it does not produce is drift.
export const browserValidatorsDirectory = "packages/contracts/src/generated/validators";
const generatedHeader =
  "// Generated from canonical schemas by scripts/generate-runtime-validators.mjs; do not edit.\n";
const frozen = (name, entries) =>
  `\nexport const ${name} = Object.freeze({\n` +
  entries.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",\n") +
  "\n});\n";
// The table and every per-definition module are bundled with these exact options.
async function bundle(contents, sourcefile, root) {
  const bundled = await build({
    stdin: { contents, sourcefile, resolveDir: root },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    minify: true,
    legalComments: "none",
  });
  return bundled.outputFiles[0].text;
}
const declaredFunctions = (code) =>
  new Set([...code.matchAll(/\bfunction (validate\d+)\(/g)].map((match) => match[1]));

/** The effective selector of a browser validator name: an own, well-formed key of `current`. */
export function browserValidatorSelector(name, current) {
  if (
    typeof name !== "string" ||
    !/^[A-Z][A-Za-z0-9]*$/.test(name) ||
    !Object.hasOwn(current, name)
  )
    throw Error("RUNTIME_VALIDATOR_BROWSER_DEFINITION_UNKNOWN:" + name);
  return current[name];
}

/**
 * Throws unless the per-definition module source `own` exports, as `ownExport`, the
 * function the table source exports as `tableExport` (`source` is that function's Ajv
 * source), carries its code byte for byte as the table does, and declares no function the
 * table does not declare.
 */
export function assertBrowserValidatorMatchesTable(
  name,
  { table, tableExport, own, ownExport, source },
) {
  const tableFunctions = declaredFunctions(table);
  const { validateName, validateCode } = source;
  if (
    !table.includes(`export const ${tableExport} = ${validateName};`) ||
    !own.includes(`export const ${ownExport} = ${validateName};`) ||
    !table.includes(validateCode) ||
    !own.includes(validateCode) ||
    [...declaredFunctions(own)].some((fn) => !tableFunctions.has(fn))
  )
    throw Error("RUNTIME_VALIDATOR_BROWSER_DIVERGED:" + name);
}

// Pure: compiles every source with one Ajv instance ahead of time and returns
// the generated files. No schema is compiled at runtime.
export async function generateRuntimeValidators(root = repositoryRoot) {
  const sources = readSchemaSources(root);
  const byKind = schemasByKind(sources);
  const catalogue = JSON.parse(
    readFileSync(resolve(root, "docs/contracts/capabilities.json"), "utf8"),
  );
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    code: { source: true, esm: true },
  });
  addFormats(ajv);
  for (const source of sources) ajv.addSchema(source.schema);
  const exports = {},
    selectors = {};
  for (const source of sources)
    for (const definition of Object.keys(source.schema.$defs).sort()) {
      const name = `v${Object.keys(exports).length}`;
      const ref = `${source.schema.$id}#/$defs/${definition}`;
      ajv.getSchema(ref);
      exports[name] = ref;
      selectors[`${source.kind}:${definition}`] = name;
    }
  const current = currentDefinitionSelectors(byKind);
  const currentBilling = currentBillingDefinitionSelectors(byKind);
  const bodies = capabilityBodySelectors(
    byKind,
    catalogue.capabilities.map((c) => c.id),
  );
  const table = standaloneCode(ajv, exports);
  const code =
    table +
    frozen("validators", Object.entries(selectors)) +
    frozen(
      "currentDefinitionSelectors",
      Object.entries(current).map(([name, selector]) => [name, JSON.stringify(selector)]),
    ) +
    frozen(
      "capabilityBodySelectors",
      Object.entries(bodies).map(([name, selector]) => [name, JSON.stringify(selector)]),
    ) +
    frozen(
      "currentBillingDefinitionSelectors",
      Object.entries(currentBilling).map(([name, selector]) => [name, JSON.stringify(selector)]),
    );
  const generated = generatedHeader + (await bundle(code, "morrow-runtime-validators.js", root));
  // Per-definition browser modules: the same Ajv instance and compiled functions as the
  // table, emitted alone. Each must export the function the table exports for its
  // selector, carry that function's code byte for byte as the table source does, and
  // declare no function the table source does not declare.
  const browserFiles = {},
    browser = {};
  for (const name of browserValidatorDefinitions) {
    const selector = browserValidatorSelector(name, current);
    const ref = exports[selectors[selector]];
    const exportName = `validate${name}`;
    const own = standaloneCode(ajv, { [exportName]: ref });
    assertBrowserValidatorMatchesTable(name, {
      table,
      tableExport: selectors[selector],
      own,
      ownExport: exportName,
      source: ajv.getSchema(ref).source,
    });
    const path = `${browserValidatorsDirectory}/${name}.mjs`;
    const text =
      generatedHeader +
      `// ${selector} alone: the validator table's compiled function, without the table.\n` +
      (await bundle(own, `morrow-validator-${name}.js`, root));
    browserFiles[path] = text;
    browserFiles[`${browserValidatorsDirectory}/${name}.d.mts`] =
      "// Generated by scripts/generate-runtime-validators.mjs; do not edit.\n" +
      `/** The effective \`${name}\` (\`${selector}\`): the table's validator for that selector, alone. */\n` +
      `export const ${exportName}: (value: unknown) => boolean;\n`;
    browser[name] = { selector, export: exportName, path, sha256: hash(text) };
  }
  const types =
    "// Generated by scripts/generate-runtime-validators.mjs; do not edit.\n" +
    "// Types for the reproducible, ahead-of-time generated ESM artifact.\n" +
    "/** Every exact selector, `<kind>:<name>`, including replaced v1 shapes kept for history. */\n" +
    "export const validators: Readonly<Record<string, (value: unknown) => boolean>>;\n" +
    "/** Effective definition name -> exact selector (newest core layer that defines it). */\n" +
    "export const currentDefinitionSelectors: Readonly<Record<string, string>>;\n" +
    "/** Effective `<capability id>.<input|output>` -> exact body selector. */\n" +
    "export const capabilityBodySelectors: Readonly<Record<string, string>>;\n" +
    "/** Effective billing definition name -> exact selector (newest billing layer that defines it). */\n" +
    "export const currentBillingDefinitionSelectors: Readonly<Record<string, string>>;\n";
  const countByKind = Object.fromEntries(
    sources.map((s) => [s.kind, Object.keys(s.schema.$defs).length]),
  );
  const manifest = {
    schema_version: 3,
    contract_version: contractVersion,
    definitions: Object.keys(selectors).length,
    definitions_by_source: countByKind,
    current_definitions: Object.keys(current).length,
    current_billing_definitions: Object.keys(currentBilling).length,
    capability_bodies: Object.keys(bodies).length,
    inputs: Object.fromEntries(sources.map((s) => [s.path, hash(s.text)])),
    compiler: { ajv: "8.20.0", formats: "3.0.1", esbuild: "0.25.12" },
    output: { path: validatorsPath, sha256: hash(generated) },
    browser_validators: browser,
    scope: "Ahead-of-time validators only; no runtime schema compilation or hosted qualification",
  };
  return {
    files: {
      [validatorsPath]: generated,
      [validatorsManifestPath]: JSON.stringify(manifest, null, 2) + "\n",
      [validatorsTypesPath]: types,
      ...browserFiles,
    },
    manifest,
    bytes: Buffer.byteLength(generated),
  };
}

/** Entries of the browser validators directory that `files` does not produce. */
export function strayBrowserValidatorFiles(files, root = repositoryRoot) {
  const directory = resolve(root, browserValidatorsDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((entry) => `${browserValidatorsDirectory}/${entry}`)
    .filter((path) => !Object.hasOwn(files, path))
    .sort();
}

/**
 * Removes the stray entries of the browser validators directory and returns them. Refuses,
 * before removing anything, if one is not a regular file.
 */
export function removeStrayBrowserValidatorFiles(files, root = repositoryRoot) {
  const stray = strayBrowserValidatorFiles(files, root);
  for (const path of stray)
    if (!statSync(resolve(root, path)).isFile())
      throw Error("RUNTIME_VALIDATOR_STRAY_DIRECTORY: " + path);
  for (const path of stray) unlinkSync(resolve(root, path));
  return stray;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, manifest, bytes } = await generateRuntimeValidators();
  const browser = Object.keys(manifest.browser_validators).length;
  if (process.argv.includes("--check")) {
    const stray = strayBrowserValidatorFiles(files);
    if (stray.length) throw Error("RUNTIME_VALIDATOR_DRIFT: " + stray.join(", "));
    for (const [path, text] of Object.entries(files)) {
      const target = resolve(repositoryRoot, path);
      if (!existsSync(target) || readFileSync(target, "utf8") !== text)
        throw Error("RUNTIME_VALIDATOR_DRIFT: " + path);
    }
    console.log(
      `PASS: ${manifest.definitions} unchanged-schema validators and ${browser} browser modules reproduce exactly.`,
    );
  } else {
    removeStrayBrowserValidatorFiles(files);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(resolve(repositoryRoot, path)), { recursive: true });
      writeFileSync(resolve(repositoryRoot, path), text);
    }
    console.log(
      `Generated ${manifest.definitions} validators; ${bytes} bytes; ${browser} browser modules.`,
    );
  }
}
