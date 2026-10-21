// M2 PR-2: the owner-run Shopify app script (scripts/shopify-app.mjs). The TOML points the
// app at the connector's exact launch and callback paths with the fixed scopes, the
// authorization-code install flow, no embedding and no webhook subscription before PR-3;
// the registration statement digests the intended shop and matches the 0026 operator
// function; production, malformed values and paths inside the repository are refused.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  parseShopifyAppArguments,
  shopDigest,
  shopifyAppRegisterStatement,
  shopifyAppToml,
} from "../scripts/shopify-app.mjs";

const clientId = "0123456789abcdef0123456789abcdef";
const tomlOptions = {
  environment: "staging",
  "app-key": "beta-store-1",
  "client-id": clientId,
  name: "Morrow (beta store 1)",
  "connector-origin": "https://morrow-staging-connector.example.workers.dev",
};
const registerOptions = {
  environment: "staging",
  "app-key": "beta-store-1",
  "client-id": clientId,
  shop: "beta-dev-store.myshopify.com",
  organization: "org_beta",
  workspace: "ws_beta",
  "install-url": "https://admin.shopify.com/oauth/install_custom_app?client_id=abc&signature=x",
};
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  return null;
};

test("toml: the connector's exact paths, fixed scopes, no embedding and no webhook subscription", () => {
  const toml = shopifyAppToml(tomlOptions);
  const base = "https://morrow-staging-connector.example.workers.dev/shopify/a/beta-store-1";
  const lines = toml.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
  assert.deepEqual(lines, [
    `client_id = "${clientId}"`,
    'name = "Morrow (beta store 1)"',
    `application_url = "${base}/launch"`,
    "embedded = false",
    "[access_scopes]",
    'scopes = "read_products,write_products"',
    "use_legacy_install_flow = true",
    "[auth]",
    `redirect_urls = [ "${base}/callback" ]`,
    "[webhooks]",
    'api_version = "2026-10"',
    "[build]",
    "automatically_update_urls_on_dev = false",
    "include_config_on_deploy = true",
  ]);
  assert.doesNotMatch(lines.join("\n"), /subscriptions|compliance_topics|uri\s*=/);
  // The paths are the connector's own route table.
  const route = /^\/shopify\/a\/([a-z0-9][a-z0-9-]{2,62})\/(launch|callback|webhooks|status)$/;
  for (const url of [`${base}/launch`, `${base}/callback`])
    assert.match(new URL(url).pathname, route);
});

test("toml: production, a bad origin, name, key or client id is refused", () => {
  for (const [change, expected] of [
    [{ environment: "production" }, "SHOPIFY_APP_SCRIPT_PRODUCTION_HELD"],
    [{ environment: "preview" }, "SHOPIFY_APP_SCRIPT_USAGE"],
    [{ "connector-origin": "http://connector.example.test" }, "SHOPIFY_APP_SCRIPT_ORIGIN_INVALID"],
    [
      { "connector-origin": "https://connector.example.test/x" },
      "SHOPIFY_APP_SCRIPT_ORIGIN_INVALID",
    ],
    [
      { "connector-origin": "https://connector.example.test:8443" },
      "SHOPIFY_APP_SCRIPT_ORIGIN_INVALID",
    ],
    [
      { "connector-origin": "https://u@connector.example.test" },
      "SHOPIFY_APP_SCRIPT_ORIGIN_INVALID",
    ],
    [{ name: 'Morrow" x' }, "SHOPIFY_APP_SCRIPT_NAME_INVALID"],
    [{ name: "x".repeat(31) }, "SHOPIFY_APP_SCRIPT_NAME_INVALID"],
    [{ "app-key": "Bad_Key" }, "SHOPIFY_APP_SCRIPT_APP_KEY_INVALID"],
    [{ "client-id": "NOTHEX" }, "SHOPIFY_APP_SCRIPT_CLIENT_ID_INVALID"],
  ])
    assert.equal(
      code(() => shopifyAppToml({ ...tomlOptions, ...change })),
      expected,
    );
});

test("register: one administrator statement with the shop digested, matching 0026", () => {
  const statement = shopifyAppRegisterStatement(registerOptions);
  assert.equal(
    statement.text,
    "SELECT outcome,app_key FROM morrow_identity.shopify_app_register($1,$2,$3,$4,$5,$6,$7)",
  );
  assert.equal(statement.executeAs, "morrow_identity_owner");
  assert.equal(statement.expectedOutcome, "registered");
  const digest = createHash("sha256").update("beta-dev-store.myshopify.com").digest("hex");
  assert.equal(shopDigest("beta-dev-store.myshopify.com"), digest);
  assert.deepEqual(statement.values, [
    "beta-store-1",
    clientId,
    "staging",
    digest,
    "org_beta",
    "ws_beta",
    registerOptions["install-url"],
  ]);
  // No shop identity in the statement.
  assert.doesNotMatch(JSON.stringify(statement), /beta-dev-store/);
  // Each value passes the operator function's own checks (migration text).
  const migration = readFileSync(
    "migrations/" +
      JSON.parse(readFileSync("migrations/manifest.json", "utf8")).migrations.find((m) =>
        m.file.endsWith(".shopify-install-identity.sql"),
      ).file,
    "utf8",
  );
  const register = migration.slice(
    migration.indexOf("CREATE FUNCTION morrow_identity.shopify_app_register("),
    migration.indexOf("CREATE FUNCTION morrow_identity.shopify_app_retire("),
  );
  const pattern = (parameter) =>
    new RegExp(register.match(new RegExp(`${parameter} !~ '([^']+)'`))[1].replaceAll("\\\\", "\\"));
  const [key, client, environment, shopHash, org, ws, url] = statement.values;
  assert.match(key, pattern("p_app_key"));
  assert.match(client, pattern("p_client_id"));
  assert.ok(register.includes("p_environment NOT IN ('development','staging')"));
  assert.ok(["development", "staging"].includes(environment));
  assert.match(shopHash, pattern("p_intended_shop_digest"));
  assert.match(org, pattern("p_org"));
  assert.match(ws, pattern("p_ws"));
  assert.match(url, pattern("p_install_url"));
  for (const [change, expected] of [
    [{ environment: "production" }, "SHOPIFY_APP_SCRIPT_PRODUCTION_HELD"],
    [{ shop: "beta.example.com" }, "SHOPIFY_APP_SCRIPT_SHOP_INVALID"],
    [{ shop: "Beta.myshopify.com" }, "SHOPIFY_APP_SCRIPT_SHOP_INVALID"],
    [{ organization: "org beta" }, "SHOPIFY_APP_SCRIPT_ID_INVALID"],
    [{ "install-url": "http://admin.shopify.com/x" }, "SHOPIFY_APP_SCRIPT_INSTALL_URL_INVALID"],
    [{ "install-url": "https://evil.test/install" }, "SHOPIFY_APP_SCRIPT_INSTALL_URL_INVALID"],
    [
      { "install-url": "https://admin.shopify.com/" + "x".repeat(2048) },
      "SHOPIFY_APP_SCRIPT_INSTALL_URL_INVALID",
    ],
  ])
    assert.equal(
      code(() => shopifyAppRegisterStatement({ ...registerOptions, ...change })),
      expected,
    );
});

test("arguments: closed flags, each once, all required", () => {
  const args = (options) => Object.entries(options).flatMap(([k, v]) => ["--" + k, v]);
  assert.equal(
    parseShopifyAppArguments(["toml", ...args({ ...tomlOptions, out: "/x" })]).command,
    "toml",
  );
  for (const argv of [
    [],
    ["deploy"],
    ["toml", ...args(tomlOptions)],
    ["toml", ...args({ ...tomlOptions, out: "/x" }), "--out", "/y"],
    ["toml", ...args({ ...tomlOptions, out: "/x" }), "--shop", "a.myshopify.com"],
    ["register", ...args({ ...registerOptions, out: "/x" }), "--webhooks"],
  ])
    assert.equal(
      code(() => parseShopifyAppArguments(argv)),
      "SHOPIFY_APP_SCRIPT_USAGE",
    );
});

test("main: new files outside the repository only; the TOML is named for its app", () => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-shopify-app-"));
  const log = console.log;
  const printed = [];
  console.log = (line) => printed.push(line);
  try {
    const args = (options) => Object.entries(options).flatMap(([k, v]) => ["--" + k, v]);
    const toml = join(dir, "shopify.app.beta-store-1.toml");
    main(["toml", ...args({ ...tomlOptions, out: toml })]);
    assert.equal(readFileSync(toml, "utf8"), shopifyAppToml(tomlOptions));
    const statementFile = join(dir, "register.json");
    main(["register", ...args({ ...registerOptions, out: statementFile })]);
    assert.deepEqual(
      JSON.parse(readFileSync(statementFile, "utf8")),
      JSON.parse(JSON.stringify(shopifyAppRegisterStatement(registerOptions))),
    );
    assert.equal(statSync(statementFile).mode & 0o777, 0o600);
    // The printed lines name no shop, digest or install link.
    assert.equal(printed.length, 2);
    assert.doesNotMatch(printed.join("\n"), /myshopify|admin\.shopify|[a-f0-9]{64}/);
    // Never overwrite, never inside the repository, and the TOML name must match its app.
    assert.throws(() => main(["toml", ...args({ ...tomlOptions, out: toml })]), /EEXIST/);
    assert.equal(
      code(() => main(["toml", ...args({ ...tomlOptions, out: "shopify.app.beta-store-1.toml" })])),
      "VAULT_SCRIPT_PATH_INSIDE_REPOSITORY",
    );
    assert.equal(
      code(() => main(["toml", ...args({ ...tomlOptions, out: join(dir, "app.toml") })])),
      "SHOPIFY_APP_SCRIPT_OUT_NAME_INVALID",
    );
    writeFileSync(join(dir, "marker"), "");
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
});
