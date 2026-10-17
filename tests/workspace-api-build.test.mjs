import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { build } from "esbuild";
import {
  createWorkspaceApiPreviewDisposal,
  parseWorkspaceApiPreviewPort,
} from "../scripts/preview-workspace-api.mjs";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/preview-workspace-api.mjs");
const packageJson = (name) => JSON.parse(readFileSync(resolve(root, name), "utf8"));

test("ordinary Node build remains first and a separate browser Worker artifact is appended", () => {
  assert.equal(
    packageJson("apps/api/package.json").scripts.build,
    "tsc -p tsconfig.json && esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs",
  );
  assert.equal(
    packageJson("apps/api/package.json").scripts["build:worker"],
    "esbuild src/worker.ts --bundle --platform=browser --format=esm --target=es2022 --external:node:* --outfile=dist/worker.mjs --metafile=dist/worker.meta.json",
  );
  assert.equal(
    packageJson("package.json").scripts.build,
    "npm run build --workspaces --if-present && npm run build:worker -w @morrow/api",
  );
  assert.equal(
    packageJson("package.json").scripts["preview:api"],
    "node scripts/preview-workspace-api.mjs",
  );
});

test("actual browser bundle has the native Worker entry and no Node HTTP server or runtime schema compiler", async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["apps/api/src/worker.ts"],
    outfile: "apps/api/dist/worker.mjs",
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["node:*"],
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs),
    output = Object.values(result.metafile.outputs);
  assert.equal(result.errors.length, 0);
  assert.equal(result.outputFiles.length, 1);
  assert.equal(output.length, 1);
  assert.equal(output[0].entryPoint, "apps/api/src/worker.ts");
  assert.ok(output[0].exports.includes("default"));
  assert.ok(output[0].exports.includes("createWorkspaceApiWorker"));
  assert.ok(inputs.includes("packages/identity/src/managed-workspace-api.ts"));
  for (const name of [
    "apps/api/src/index.ts",
    "apps/api/src/auth-http.ts",
    "apps/api/src/workspace-http.ts",
    "apps/api/src/workspace-router.ts",
  ])
    assert.ok(!inputs.includes(name), name);
  assert.ok(!inputs.some((name) => /(?:^|\/)ajv\/(?:dist|lib)\/compile\//.test(name)));
  const text = result.outputFiles[0].text;
  assert.ok(!/\bcreateServer\s*\(/.test(text));
  assert.ok(!/from\s*["']node:https?["']/.test(text));
  assert.ok(!/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(text));
});

test("preview import and help are inert without reading a build artifact or starting workerd", () => {
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import(process.argv[1]);",
      new URL("../scripts/preview-workspace-api.mjs", import.meta.url).href,
    ],
    { timeout: 4000, encoding: "utf8", cwd: root },
  );
  assert.equal(imported.error, undefined);
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  const help = spawnSync(process.execPath, [script, "--help"], {
    timeout: 4000,
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Loopback-only, unconfigured Worker/);
  assert.equal(help.stderr, "");
});

test("preview accepts only one canonical bounded port and cannot select a host or binding", () => {
  assert.equal(parseWorkspaceApiPreviewPort([]), 8787);
  for (const value of [0, 1, 8787, 65535])
    assert.equal(parseWorkspaceApiPreviewPort(["--port=" + value]), value);
  for (const args of [
    ["--host=0.0.0.0"],
    ["--binding=secret"],
    ["--port=-1"],
    ["--port=65536"],
    ["--port=01"],
    ["--port=1\n"],
    ["--port=1", "--port=2"],
    ["--port=1e3"],
    [null],
    "--port=8787",
  ])
    assert.throws(() => parseWorkspaceApiPreviewPort(args), /WORKSPACE_API_PREVIEW_INVALID/);
});

for (const rejected of [false, true]) {
  test(
    "concurrent preview shutdown preserves exactly one disposal " +
      (rejected ? "rejection" : "acknowledgement"),
    async () => {
      let calls = 0,
        finish;
      const runtime = {
        dispose() {
          assert.equal(this, runtime);
          calls++;
          return new Promise((yes, no) => {
            finish = rejected ? () => no(Error("synthetic disposal held")) : yes;
          });
        },
      };
      const stop = createWorkspaceApiPreviewDisposal(runtime),
        first = stop();
      assert.equal(first, stop());
      assert.equal(calls, 0);
      await Promise.resolve();
      assert.equal(calls, 1);
      finish();
      if (rejected) await assert.rejects(first, /synthetic disposal held/);
      else await first;
      assert.equal(stop(), first);
      assert.equal(calls, 1);
    },
  );
}

// Execute the actual source functions with a test-only module substitution.
// This exercises readiness/disposal code, not a native runtime or app binding.
function previewHarness(ready) {
  const source = readFileSync(script, "utf8"),
    file = ts.createSourceFile(script, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
    names = ["createWorkspaceApiPreviewDisposal", "createWorkspaceApiPreview"],
    selected = file.statements.filter(
      (node) => ts.isFunctionDeclaration(node) && names.includes(node.name.text),
    );
  assert.equal(selected.length, 2);
  let text = selected.map((node) => node.getText(file).replace(/^export /, "")).join("\n");
  assert.equal(text.split('await import("miniflare")').length, 2);
  text = text.replace('await import("miniflare")', "runtimeModule");
  const observation = { constructions: 0, closes: 0, options: null };
  const context = vm.createContext({
    Object,
    Promise,
    URL,
    Number,
    Error,
    process: { version: "v24.13.0" },
    artifact: "/fixed-unconfigured-worker.mjs",
    root: "/fixed-repository",
    resolve,
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => '{"version":"4.20260730.0"}',
    invalid: () => Error("WORKSPACE_API_PREVIEW_INVALID"),
    runtimeModule: {
      Response,
      Miniflare: class {
        constructor(options) {
          observation.constructions++;
          observation.options = options;
        }
        get ready() {
          return ready;
        }
        dispose() {
          observation.closes++;
          return Promise.resolve();
        }
      },
    },
  });
  vm.runInContext(text + "\nglobalThis.start = createWorkspaceApiPreview;", context);
  return { start: context.start, observation };
}

test("actual preview setup fixes loopback, compatibility and deny-only outbound with no account bindings", async () => {
  const f = previewHarness(Promise.resolve(new URL("http://127.0.0.1:43891/"))),
    preview = await f.start(0);
  assert.equal(await preview.ready, "http://127.0.0.1:43891/");
  const options = f.observation.options;
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 0);
  assert.equal(options.scriptPath, "/fixed-unconfigured-worker.mjs");
  assert.equal(options.compatibilityDate, "2026-07-30");
  assert.deepEqual([...options.compatibilityFlags], ["nodejs_compat"]);
  assert.equal(options.cf, false);
  assert.equal(options.liveReload, false);
  assert.equal(Object.hasOwn(options, "bindings"), false);
  assert.equal(Object.hasOwn(options, "serviceBindings"), false);
  assert.equal(
    (await options.outboundService(new Request("https://foreign.example/"))).status,
    503,
  );
  await preview.stop();
  assert.equal(f.observation.closes, 1);
});

for (const failure of ["readiness", "nonloopback"]) {
  test("actual preview " + failure + " failure joins once-only supported disposal", async () => {
    let settle;
    const pending = new Promise((yes, no) => {
      settle =
        failure === "readiness"
          ? () => no(Error("synthetic ready held"))
          : () => yes(new URL("http://0.0.0.0:8787/"));
    });
    const f = previewHarness(pending),
      preview = await f.start(8787);
    const stop = preview.stop();
    settle();
    await assert.rejects(preview.ready, /WORKSPACE_API_PREVIEW_INVALID/);
    assert.equal(preview.stop(), stop);
    assert.equal(f.observation.closes, 1);
  });
}

function cliHarness(create) {
  const source = readFileSync(script, "utf8"),
    file = ts.createSourceFile(script, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
    main = file.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name.text === "main",
    ),
    listeners = new Map(),
    output = [];
  const process = {
    argv: ["node", "preview"],
    stdout: { write: (text) => output.push(text) },
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
  };
  const context = vm.createContext({
    process,
    createWorkspaceApiPreview: create,
    parseWorkspaceApiPreviewPort,
    invalid: () => Error("WORKSPACE_API_PREVIEW_INVALID"),
  });
  vm.runInContext(main.getText(file) + "\nglobalThis.run = main;", context);
  return { run: context.run, signal: () => listeners.get("SIGTERM")?.(), output, listeners };
}

test("a signal during readiness waits for disposal without reporting a successful preview", async () => {
  let denyReady,
    completeStop,
    enteredReady,
    enteredStop,
    stops = 0;
  const readEntered = new Promise((yes) => {
      enteredReady = yes;
    }),
    stopEntered = new Promise((yes) => {
      enteredStop = yes;
    }),
    ready = new Promise((_yes, no) => {
      denyReady = no;
    });
  void ready.catch(() => {}); // the real source constructor attaches this sink
  const stop = createWorkspaceApiPreviewDisposal({
    dispose() {
      stops++;
      enteredStop();
      return new Promise((yes) => {
        completeStop = yes;
      });
    },
  });
  const f = cliHarness(async () => ({
      get ready() {
        enteredReady();
        return ready;
      },
      stop,
    })),
    running = f.run();
  await readEntered;
  f.signal();
  denyReady(Error("synthetic readiness canceled"));
  await stopEntered;
  assert.equal(stops, 1);
  assert.deepEqual(f.output, []);
  completeStop();
  await running;
  assert.equal(f.listeners.size, 0);
});

test("a signal before startup returns still disposes the later published runtime exactly once", async () => {
  let publish,
    stops = 0;
  const stop = createWorkspaceApiPreviewDisposal({
      dispose() {
        stops++;
      },
    }),
    f = cliHarness(
      () =>
        new Promise((yes) => {
          publish = yes;
        }),
    ),
    running = f.run();
  f.signal();
  publish({ ready: Promise.resolve("http://127.0.0.1:8787/"), stop });
  await running;
  assert.equal(stops, 1);
  assert.deepEqual(f.output, []);
  assert.equal(f.listeners.size, 0);
});

test("readiness failure removes signal handlers and preserves a held result after acknowledged disposal", async () => {
  let deny,
    stops = 0;
  const ready = new Promise((_yes, no) => {
      deny = no;
    }),
    stop = createWorkspaceApiPreviewDisposal({
      dispose() {
        stops++;
      },
    }),
    f = cliHarness(async () => ({ ready, stop })),
    running = f.run();
  await Promise.resolve();
  deny(Error("synthetic startup held"));
  await assert.rejects(running, /WORKSPACE_API_PREVIEW_INVALID/);
  assert.equal(stops, 1);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.output, []);
});
