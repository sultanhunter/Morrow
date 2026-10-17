import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(root, "apps/api/dist/worker.mjs");
const invalid = () => Error("WORKSPACE_API_PREVIEW_INVALID");

export function parseWorkspaceApiPreviewPort(args) {
  if (!Array.isArray(args) || args.length > 1) throw invalid();
  if (args.length === 0) return 8787;
  if (typeof args[0] !== "string") throw invalid();
  const match = /^--port=(0|[1-9][0-9]{0,4})$/.exec(args[0]);
  if (!match || Number(match[1]) > 65535 || args[0] !== "--port=" + String(Number(match[1])))
    throw invalid();
  return Number(match[1]);
}

// A supported disposal is attempted exactly once, including concurrent signals
// and readiness failure. A rejected acknowledgement is retained, never retried.
export function createWorkspaceApiPreviewDisposal(runtime) {
  let pending;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(() => runtime.dispose());
      void pending.catch(() => {});
    }
    return pending;
  };
}

export async function createWorkspaceApiPreview(port = 8787) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || process.version !== "v24.13.0")
    throw invalid();
  if (!statSync(artifact).isFile()) throw invalid();
  const installed = JSON.parse(readFileSync(resolve(root, "node_modules/miniflare/package.json")));
  if (installed.version !== "4.20260730.0") throw invalid();
  const { Miniflare, Response: MiniflareResponse } = await import("miniflare");
  const runtime = new Miniflare({
    modules: true,
    scriptPath: artifact,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    port,
    cf: false,
    liveReload: false,
    outboundService: () => new MiniflareResponse(null, { status: 503 }),
  });
  const stop = createWorkspaceApiPreviewDisposal(runtime);
  const ready = Promise.resolve(runtime.ready)
    .then((url) => {
      if (!(url instanceof URL) || url.protocol !== "http:" || url.hostname !== "127.0.0.1")
        throw invalid();
      return url.href;
    })
    .catch(async () => {
      await stop();
      throw invalid();
    });
  void ready.catch(() => {});
  return Object.freeze({ ready, stop });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: npm run preview:api -- [--port=0..65535]\nLoopback-only, unconfigured Worker; build first.\n",
    );
    return;
  }
  const port = parseWorkspaceApiPreviewPort(args);
  let preview,
    stopping = false;
  const remove = () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
  const stop = () => {
    stopping = true;
    if (preview)
      void preview
        .stop()
        .catch(() => {
          process.exitCode = 1;
        })
        .finally(remove);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    preview = await createWorkspaceApiPreview(port);
    if (stopping) {
      await preview.stop();
      remove();
      return;
    }
    const url = await preview.ready;
    if (!stopping) process.stdout.write("Morrow unconfigured Worker preview: " + url + "\n");
  } catch {
    if (stopping && preview) {
      try {
        await preview.stop();
        remove();
        return;
      } catch {
        // A requested stop still requires a real disposal acknowledgement.
      }
    }
    if (preview) await preview.stop().catch(() => {});
    remove();
    throw invalid();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write("WORKSPACE_API_PREVIEW_HELD\n");
    process.exitCode = 1;
  });
}
