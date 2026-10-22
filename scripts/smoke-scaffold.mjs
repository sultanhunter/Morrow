import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { writeArtifact } from "./artifacts.mjs";
import { contractVersion } from "./contract-sources.mjs";
const children = [],
  checks = [],
  logs = [];
const start = (label, args, env = {}, cwd = process.cwd()) => {
  const p = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(p);
  p.stdout.on("data", (x) => logs.push({ label, text: String(x) }));
  p.stderr.on("data", (x) => logs.push({ label, text: String(x) }));
  return p;
};
const poll = async (url) => {
  for (let n = 0; n < 100; n++) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw Error("Local scaffold did not become reachable");
};
const check = (name, passed) => {
  checks.push({ name, passed });
  if (!passed) throw Error(name);
};
try {
  start("api", ["apps/api/dist/index.mjs"], { MORROW_API_PORT: "4191" });
  const health = await poll("http://127.0.0.1:4191/health");
  check(
    `API build reports contract version ${contractVersion}`,
    (await health.json()).contracts === contractVersion,
  );
  const privateEntry = await fetch(
    "http://127.0.0.1:4191/workspace?shop=forged.myshopify.com&host=standalone",
  );
  check("Forged shop/host cannot grant private entry", privateEntry.status === 401);
  const login = await fetch("http://127.0.0.1:4191/auth/login", { method: "POST" });
  check(
    "Unconfigured API cannot start login or issue a cookie",
    login.status === 404 && login.headers.getSetCookie().length === 0,
  );
  const logout = await fetch("http://127.0.0.1:4191/auth/logout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      Cookie: "__Host-morrow_session=" + "A".repeat(43),
    },
    body: JSON.stringify({ schemaVersion: 1 }),
  });
  check(
    "Unconfigured API cannot retire a session or mutate cookies",
    logout.status === 404 && logout.headers.getSetCookie().length === 0,
  );
  // M5 PR-1: the unconfigured api reads no billing record and accepts no Stripe webhook.
  const billing = await fetch("http://127.0.0.1:4191/workspace/ws_smoke/billing/morrow/plans");
  check(
    "Unconfigured API cannot read billing or open a purchase",
    billing.status === 401 && billing.headers.getSetCookie().length === 0,
  );
  const stripeWebhook = await fetch("http://127.0.0.1:4191/api/billing/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": "t=1,v1=" + "a".repeat(64), "Content-Type": "application/json" },
    body: "{}",
  });
  check(
    "Unconfigured API accepts no Stripe webhook",
    stripeWebhook.status === 404 && (await stripeWebhook.json()).code === "not_found",
  );
  start(
    "connector",
    ["node_modules/@react-router/serve/bin.js", "apps/shopify-connector/build/server/index.js"],
    { NODE_ENV: "production", HOST: "127.0.0.1", PORT: "4192", MORROW_CONNECTOR_FIXTURES: "1" },
  );
  const connector = await poll("http://127.0.0.1:4192/");
  check("Unconfigured real connector entry fails closed", connector.status === 503);
  const auth = await fetch("http://127.0.0.1:4192/auth/login?shop=forged.myshopify.com");
  check("Shop query cannot authenticate installation", auth.status === 503);
  const fixture = await fetch("http://127.0.0.1:4192/dev/fixture");
  check("Production refuses development fixture even with flag", fixture.status === 404);
  const headers = connector.headers;
  check("Private connector response disables caching", headers.get("cache-control") === "no-store");
  check(
    "Unqualified connector is not embeddable",
    headers.get("content-security-policy")?.includes("frame-ancestors 'none'"),
  );
  const worker = start("worker", ["apps/workers/dist/index.mjs"]);
  await new Promise((resolve, reject) =>
    worker.on("exit", (code) => (code === 0 ? resolve() : reject(Error("Worker failed")))),
  );
  const workerLog = logs
    .filter((x) => x.label === "worker")
    .map((x) => x.text)
    .join("");
  check("Worker smoke has no dispatch mode", workerLog.includes('"mode":"scaffold"'));
  check(
    `Worker build reports contract version ${contractVersion}`,
    workerLog.includes(`"contracts":${JSON.stringify(contractVersion)}`),
  );
  start(
    "connector-dev",
    [
      resolve("node_modules/@react-router/dev/bin.js"),
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "4193",
    ],
    { MORROW_CONNECTOR_FIXTURES: "1", NODE_ENV: "development" },
    resolve("apps/shopify-connector"),
  );
  const dev = await poll("http://127.0.0.1:4193/dev/fixture");
  check("Explicit synthetic connector entry starts without credentials", dev.status === 200);
  writeArtifact("smoke/scaffold.json", {
    generated_at: new Date().toISOString(),
    scope:
      "Local production build HTTP status/headers and no-dispatch worker only, no authenticated tenant/provider qualification.",
    checks,
  });
  console.log(`PASS: ${checks.length} scaffold guards.`);
} finally {
  for (const p of children) p.kill("SIGTERM");
}
