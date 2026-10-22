// The owner-run Shopify app script (M2 PR-2; the M2 brief, flow 1; ADR-0022 items 4 and 6;
// ADR-0008 as amended 2026-10-20). One custom-distribution app per beta development store.
// It runs on the owner's machine only, never on CI, an agent or a hosted host, and makes no
// network call, provider resource or database write itself:
//
//   npm run shopify-app -- toml --environment <development|staging> --app-key <key>
//       --client-id <32 hex> --name <app name> --connector-origin <https origin> --out <file>
//       Writes shopify.app.<key>.toml (a new file outside the repository) for the owner's
//       `shopify app deploy`: embedded = false; the fixed scopes read_products,write_products
//       with use_legacy_install_flow = true (the authorization-code grant the connector's
//       callback completes, for a non-expiring offline token); application_url the
//       connector's launch path and the one redirect URL its callback path; the webhooks
//       api_version 2026-10 and, since M2 PR-3 added the inbox, the five topics of ADR-0022
//       item 4 to the connector's webhook path: app/uninstalled and app/scopes_update, and
//       the three compliance topics (no product topics).
//   npm run shopify-app -- register --environment <development|staging> --app-key <key>
//       --client-id <32 hex> --shop <name>.myshopify.com --organization <id>
//       --workspace <id> --install-url <custom distribution link> --out <file>
//       Writes the administrator statement for morrow_identity.shopify_app_register (a new
//       0600 file outside the repository), run as morrow_identity_owner inside the
//       administrator's own transaction (the ADR-0020 runner shape), which commits only on
//       `registered`. The shop domain is digested here and never stored or printed.
//
// Production is refused until the production custody ADR (ADR-0007 item 9) and ADR-0022
// item 4's move off development stores. Fixed error codes only; nothing secret is handled
// (the client secret goes through `npm run vault -- seal-app-secret`).
import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { outsideRepository } from "./vault.mjs";

const fail = (code) => Error("SHOPIFY_APP_SCRIPT_" + code);
export const shopifyAppApiVersion = "2026-10";
export const shopifyAppScopes = "read_products,write_products";
const appKeyPattern = /^[a-z0-9][a-z0-9-]{2,62}$/;
const clientIdPattern = /^[a-f0-9]{32}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9 &'().,-]{0,29}$/;
const shopPattern = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The InstallLinkOffer and shopify_app_register shape: Shopify's admin or a myshopify host.
const installUrlPattern =
  /^https:\/\/(admin\.shopify\.com|[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com)\/[!-~]+$/;
const environments = ["development", "staging"];
const usage =
  "usage: shopify-app.mjs toml --environment <env> --app-key <key> --client-id <hex> --name <name> --connector-origin <origin> --out <file> | register --environment <env> --app-key <key> --client-id <hex> --shop <domain> --organization <id> --workspace <id> --install-url <url> --out <file>";

export function parseShopifyAppArguments(argv) {
  const [command, ...rest] = argv;
  const allowed = {
    toml: ["environment", "app-key", "client-id", "name", "connector-origin", "out"],
    register: [
      "environment",
      "app-key",
      "client-id",
      "shop",
      "organization",
      "workspace",
      "install-url",
      "out",
    ],
  }[command];
  if (!allowed) throw fail("USAGE");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = /^--([a-z-]+)$/.exec(rest[i] ?? "")?.[1];
    const value = rest[i + 1];
    if (!flag || !allowed.includes(flag) || Object.hasOwn(options, flag) || value === undefined)
      throw fail("USAGE");
    options[flag] = value;
  }
  if (allowed.some((flag) => !Object.hasOwn(options, flag))) throw fail("USAGE");
  return { command, options };
}

function common(options) {
  if (options.environment === "production") throw fail("PRODUCTION_HELD");
  if (!environments.includes(options.environment)) throw fail("USAGE");
  if (!appKeyPattern.test(options["app-key"])) throw fail("APP_KEY_INVALID");
  if (!clientIdPattern.test(options["client-id"])) throw fail("CLIENT_ID_INVALID");
}
// The connector's own https origin exactly: no path, query, credentials or port.
function connectorOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("ORIGIN_INVALID");
  }
  if (url.protocol !== "https:" || url.origin !== value || url.port !== "" || url.username)
    throw fail("ORIGIN_INVALID");
  return url.origin;
}

/** The app configuration TOML. Every value is pattern-checked, so none needs escaping. */
export function shopifyAppToml(options) {
  common(options);
  if (!namePattern.test(options.name)) throw fail("NAME_INVALID");
  const origin = connectorOrigin(options["connector-origin"]);
  const base = `${origin}/shopify/a/${options["app-key"]}`;
  return [
    `# Morrow custom-distribution app for one beta development store (${options.environment}).`,
    "# Generated by `npm run shopify-app -- toml`; deploy with `shopify app deploy`, then",
    "# choose custom distribution and generate the install link for the one store.",
    `client_id = "${options["client-id"]}"`,
    `name = "${options.name}"`,
    `application_url = "${base}/launch"`,
    "embedded = false",
    "",
    "[access_scopes]",
    `scopes = "${shopifyAppScopes}"`,
    "use_legacy_install_flow = true",
    "",
    "[auth]",
    `redirect_urls = [ "${base}/callback" ]`,
    "",
    "[webhooks]",
    `api_version = "${shopifyAppApiVersion}"`,
    "",
    "# ADR-0022 item 4: the app topics and the three compliance topics, to the connector's",
    "# signed webhook path (M2 PR-3: the broker records each delivery before the 200).",
    "[[webhooks.subscriptions]]",
    'topics = [ "app/uninstalled", "app/scopes_update" ]',
    `uri = "${base}/webhooks"`,
    "",
    "[[webhooks.subscriptions]]",
    'compliance_topics = [ "customers/data_request", "customers/redact", "shop/redact" ]',
    `uri = "${base}/webhooks"`,
    "",
    "[build]",
    "automatically_update_urls_on_dev = false",
    "include_config_on_deploy = true",
    "",
  ].join("\n");
}
export const shopDigest = (shop) => createHash("sha256").update(shop, "utf8").digest("hex");

/**
 * The administrator runner's one statement for an app registration, run as
 * morrow_identity_owner in its own transaction: it commits only on `registered`.
 */
export function shopifyAppRegisterStatement(options) {
  common(options);
  if (!shopPattern.test(options.shop)) throw fail("SHOP_INVALID");
  if (!idPattern.test(options.organization) || !idPattern.test(options.workspace))
    throw fail("ID_INVALID");
  if (options["install-url"].length > 2048 || !installUrlPattern.test(options["install-url"]))
    throw fail("INSTALL_URL_INVALID");
  return Object.freeze({
    schemaVersion: 1,
    kind: "morrow.shopify.app_register_statement",
    executeAs: "morrow_identity_owner",
    text: "SELECT outcome,app_key FROM morrow_identity.shopify_app_register($1,$2,$3,$4,$5,$6,$7)",
    values: Object.freeze([
      options["app-key"],
      options["client-id"],
      options.environment,
      shopDigest(options.shop),
      options.organization,
      options.workspace,
      options["install-url"],
    ]),
    expectedOutcome: "registered",
  });
}

function writeNew(path, text, mode) {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

export function main(argv = process.argv.slice(2)) {
  const { command, options } = parseShopifyAppArguments(argv);
  const out = outsideRepository(options.out);
  if (command === "toml") {
    if (basename(out) !== `shopify.app.${options["app-key"]}.toml`) throw fail("OUT_NAME_INVALID");
    writeNew(out, shopifyAppToml(options), 0o644);
    console.log(
      JSON.stringify({
        written: "toml",
        environment: options.environment,
        appKey: options["app-key"],
      }),
    );
    return;
  }
  const statement = shopifyAppRegisterStatement(options);
  writeNew(out, JSON.stringify(statement) + "\n", 0o600);
  console.log(
    JSON.stringify({
      written: "register_statement",
      environment: options.environment,
      appKey: options["app-key"],
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try {
    main();
  } catch (error) {
    // Fixed codes only: never a value, path content or stack.
    const code = /^(SHOPIFY_APP_SCRIPT_[A-Z_]+|VAULT_SCRIPT_[A-Z_]+)$/.exec(
      error?.message ?? "",
    )?.[1];
    console.error(code ?? "SHOPIFY_APP_SCRIPT_FAILED");
    if (code === "SHOPIFY_APP_SCRIPT_USAGE") console.error(usage);
    process.exitCode = 1;
  }
