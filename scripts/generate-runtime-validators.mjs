import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourcePaths = ["core", "capabilities", "billing"].map(
  (name) => `docs/contracts/schemas/v1/${name}.schema.json`,
);
const inputs = sourcePaths.map((path) => readFileSync(path, "utf8"));
const schemas = inputs.map((text) => JSON.parse(text));
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
for (const schema of schemas) ajv.addSchema(schema);
const exports = {},
  selectors = {};
for (let index = 0; index < schemas.length; index++) {
  const schema = schemas[index];
  const kind = ["core", "capabilities", "billing"][index];
  for (const definition of Object.keys(schema.$defs).sort()) {
    const name = `v${Object.keys(exports).length}`;
    const ref = `${schema.$id}#/$defs/${definition}`;
    ajv.getSchema(ref);
    exports[name] = ref;
    selectors[`${kind}:${definition}`] = name;
  }
}
const code =
  standaloneCode(ajv, exports) +
  "\nexport const validators = Object.freeze({\n" +
  Object.entries(selectors)
    .map(([selector, name]) => `${JSON.stringify(selector)}:${name}`)
    .join(",\n") +
  "\n});\n";
const bundled = await build({
  stdin: { contents: code, sourcefile: "morrow-runtime-validators.js", resolveDir: process.cwd() },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
  minify: true,
  legalComments: "none",
});
const generated =
  "// Generated from canonical schemas by scripts/generate-runtime-validators.mjs; do not edit.\n" +
  bundled.outputFiles[0].text;
const path = "packages/contracts/src/generated/runtime-validators.mjs";
const manifestPath = "packages/contracts/src/generated/runtime-validators.json";
const manifest =
  JSON.stringify(
    {
      schema_version: 1,
      definitions: Object.keys(selectors).length,
      inputs: Object.fromEntries(sourcePaths.map((path, i) => [path, hash(inputs[i])])),
      compiler: { ajv: "8.20.0", formats: "3.0.1", esbuild: "0.25.12" },
      output: { path, sha256: hash(generated) },
      scope: "Ahead-of-time validators only; no runtime schema compilation or hosted qualification",
    },
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== generated || readFileSync(manifestPath, "utf8") !== manifest)
    throw Error("RUNTIME_VALIDATOR_DRIFT");
  console.log(
    `PASS: ${Object.keys(selectors).length} unchanged-schema validators reproduce exactly.`,
  );
} else {
  writeFileSync(path, generated);
  writeFileSync(manifestPath, manifest);
  console.log(
    `Generated ${Object.keys(selectors).length} validators; ${Buffer.byteLength(generated)} bytes.`,
  );
}
