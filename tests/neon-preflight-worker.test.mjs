import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { neonPreflightEgressScript } from "../scripts/neon-preflight-egress.mjs";

test("real local workerd permits only the exact Neon WSS address; provider failures disclose no credential", async () => {
  const host = "ep-synthetic.us-east-2.aws.neon.tech",
    secret = "synthetic-test-secret";
  const bundle = await build({
    entryPoints: ["scripts/fixtures/neon-staging-preflight.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  let calls = 0;
  const runtime = new Miniflare({
    log: new Log(LogLevel.NONE),
    workers: [
      {
        name: "qualification",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          QUALIFICATION: JSON.stringify({
            hostname: host,
            database: "morrow_staging",
            ownerUser: "neondb_owner",
            ownerPassword: secret,
          }),
        },
        outboundService: "egress",
      },
      {
        name: "egress",
        modules: true,
        script: neonPreflightEgressScript,
        compatibilityDate: "2026-07-30",
        bindings: { HOST: host },
        outboundService: () => {
          calls++;
          return new Response(null, { status: 502 });
        },
      },
    ],
  });
  try {
    const egress = await runtime.getWorker("egress");
    const legitimate = `https://${host}/v2?address=${host}:5432`;
    assert.equal((await egress.fetch(legitimate)).status, 502);
    assert.equal(calls, 1);
    for (const denied of [
      `http://${host}/v2?address=${host}:5432`,
      `https://attacker.test/v2?address=${host}:5432`,
      `https://${host}/v2?address=localhost:5432`,
      `https://${host}/v2?address=${host}:5433`,
      `https://${host}/v2?address=${host}:5432&extra=1`,
      `https://${host}/v2`,
      `https://${host}/elsewhere?address=${host}:5432`,
    ])
      assert.equal((await egress.fetch(denied)).status, 403);
    assert.equal(calls, 1);
    const failed = await runtime.dispatchFetch("http://qualification.local/preflight", {
      method: "POST",
    });
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { passed: false, code: "NEON_PREFLIGHT_FAILED" });
    assert.ok(calls > 1); // The real SDK attempted only the controlled, denied WSS hop.
    assert.equal((await runtime.dispatchFetch("http://qualification.local/preflight")).status, 404);
  } finally {
    await runtime.dispose();
  }
});
