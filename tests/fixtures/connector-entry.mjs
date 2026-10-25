// The connector's deployed entry (apps/shopify-connector/worker/index.ts) for unit tests.
// fix-connector-cron-latency: index.ts imports cloudflare:workers (ConnectorCron extends
// DurableObject), which Node cannot load, so the entry is bundled here with that module
// stubbed. The Neon driver is replaced too: its Client asks globalThis.__morrowConnectorNeon
// (set by a test) for each connection, so a test decides what every round trip costs and
// answers; a test that never sets it never opens a connection. Nothing reaches a network.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const stubs = {
  "cloudflare:workers":
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  // The driver surface database.ts uses: the constructor's config, neonConfig, on, connect,
  // query and end.
  "@neondatabase/serverless": `export class Client {
  constructor(config) {
    const neon = globalThis.__morrowConnectorNeon;
    if (!neon) throw Error("CONNECTOR_ENTRY_NO_FAKE_NEON");
    this.neonConfig = {};
    this.connection = neon.open(config);
  }
  on() {}
  connect() { return this.connection.connect(); }
  query(text, values) { return this.connection.query(text, values); }
  end() { return this.connection.end(); }
}`,
};

/** Bundles the entry and imports it; the bundle's directory is removed once it is loaded. */
export async function loadConnectorEntry() {
  const directory = mkdtempSync(join(tmpdir(), "morrow-connector-entry-"));
  try {
    const bundled = await build({
      entryPoints: [
        fileURLToPath(new URL("../../apps/shopify-connector/worker/index.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      external: ["node:*"],
      mainFields: ["module", "main"],
      logLevel: "silent",
      plugins: [
        {
          name: "connector-entry-stubs",
          setup(b) {
            b.onResolve({ filter: /^(cloudflare:workers|@neondatabase\/serverless)$/ }, (args) => ({
              path: args.path,
              namespace: "stub",
            }));
            b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
              contents: stubs[args.path],
            }));
          },
        },
      ],
    });
    const file = join(directory, "connector-entry.mjs");
    writeFileSync(file, bundled.outputFiles[0].text);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
