// External tools behind the staging subcommands (P04.T01i D2 "Secret handling"):
// wrangler, gh, git and neonctl as child processes, and a direct Cloudflare API client.
// Every tool returns {status, stdout, stderr} to its caller, which parses names and ids
// out of stdout with closed parsers and otherwise reports a fixed code with the exit
// status: raw tool output is never relayed. Credentials reach a child only through its
// environment (the Cloudflare token, ADR-0019 item 14; NEON_API_KEY for neonctl) or
// stdin (`wrangler secret bulk`), never argv. Tests and labs replace the whole `tools`
// object with fakes (tests/fixtures/staging-fakes.mjs).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edgeChildEnvironment } from "./edge.mjs";
import { StagingError } from "./staging-common.mjs";

const outputLimit = 4 << 20;

// One child, no shell. stdin is the only channel for input; output is capped.
export function runChild(command, args, { cwd, env, input, timeoutMs = 120000 } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    return Promise.reject(new StagingError("STAGING_TOOL_ARGUMENTS"));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch {
      resolve({ status: null, stdout: "", stderr: "", error: "spawn" });
      return;
    }
    let stdout = "",
      stderr = "",
      overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > outputLimit) overflow = true;
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length <= outputLimit) stderr += chunk;
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: overflow ? null : code,
        signal: signal ?? null,
        stdout: overflow ? "" : stdout,
        stderr,
        error: overflow ? "overflow" : null,
      });
    });
    child.stdin.end(input ?? "");
  });
}

// The real tools. `credential` is the opaque Cloudflare handle from staging-token.mjs;
// `accountId` is the committed, reviewed account (staging.json). gh keeps the operator's
// own login (its config under the real HOME); every other child gets a throwaway HOME.
// `github` is the opaque GH_TOKEN handle from staging-token.mjs (null locally).
export function createTools({
  root,
  home,
  credential = null,
  accountId = null,
  neonApiKey = null,
  github = null,
}) {
  const wranglerBin = join(root, "node_modules/wrangler/bin/wrangler.js");
  const neonctlBin = join(root, "node_modules/neonctl/bin/cli.js");
  const throwaway = async (use) => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-staging-home-"));
    try {
      return await use(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return Object.freeze({
    // `outputFile` adds wrangler's structured output (WRANGLER_OUTPUT_FILE_PATH, one JSON
    // object per line) as `output`, so callers read ids from it rather than from text.
    async wrangler(args, { input, outputFile = false } = {}) {
      if (!credential || !/^[0-9a-f]{32}$/.test(accountId ?? ""))
        throw new StagingError("STAGING_CLOUDFLARE_UNCONFIGURED");
      return throwaway(async (dir) => {
        const empty = join(dir, "empty.env");
        writeFileSync(empty, "", { mode: 0o600 });
        const outputPath = join(dir, "wrangler-output.ndjson");
        const env = credential.childEnvironment({
          ...edgeChildEnvironment(dir),
          CLOUDFLARE_ACCOUNT_ID: accountId,
          ...(outputFile ? { WRANGLER_OUTPUT_FILE_PATH: outputPath } : {}),
        });
        const result = await runChild(
          process.execPath,
          [wranglerBin, ...args, "--env-file=" + empty],
          { cwd: root, env, input, timeoutMs: outputFile ? 600000 : 120000 },
        );
        return outputFile ? { ...result, output: readOutputEntries(outputPath) } : result;
      });
    },
    async neonctl(args, { input } = {}) {
      if (typeof neonApiKey !== "string") throw new StagingError("STAGING_NEON_UNCONFIGURED");
      return throwaway((dir) =>
        runChild(process.execPath, [neonctlBin, ...args, "--no-analytics", "--no-color"], {
          cwd: dir,
          env: { PATH: process.env.PATH ?? "", HOME: dir, LANG: "C", NEON_API_KEY: neonApiKey },
          input,
        }),
      );
    },
    gh(args, { input } = {}) {
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        LANG: "C",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
        ...(process.env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR } : {}),
      };
      // In the CI steps gh authenticates with the workflow's own GH_TOKEN (contents: read,
      // actions: read). staging-token.mjs removed it from process.env at startup, so it
      // reaches gh children only, never wrangler, neonctl, git or any in-process module.
      return runChild("gh", args, {
        cwd: root,
        env: github ? github.childEnvironment(env) : env,
        input,
      });
    },
    git(args) {
      return runChild("git", args, {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", HOME: home, LANG: "C", GIT_TERMINAL_PROMPT: "0" },
      });
    },
  });
}

// wrangler's output file: objects only, at most 64 entries; unreadable lines are skipped.
export function readOutputEntries(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n").slice(0, 64)) {
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) entries.push(value);
    } catch {
      // Not an entry.
    }
  }
  return entries;
}

// Parsers: closed shapes in, names and ids out. Anything else is a fixed code.
const parseJson = (text, code) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new StagingError(code);
  }
};
const toolFailure = (tool, result) =>
  new StagingError("STAGING_" + tool.toUpperCase() + "_FAILED", {
    status: Number.isSafeInteger(result?.status) ? result.status : null,
  });
export async function toolJson(tools, tool, args, options = {}) {
  const result = await tools[tool](args, options);
  if (result?.status !== 0) throw toolFailure(tool, result);
  return parseJson(result.stdout, "STAGING_" + tool.toUpperCase() + "_OUTPUT_INVALID");
}
export async function toolOk(tools, tool, args, options = {}) {
  const result = await tools[tool](args, options);
  if (result?.status !== 0) throw toolFailure(tool, result);
  return result.stdout;
}

const secretName = /^[A-Z][A-Z0-9_]{0,127}$/;
// `wrangler secret list --format json`: [{name, type}] -> sorted names.
export function secretNames(value) {
  if (!Array.isArray(value) || value.length > 128)
    throw new StagingError("STAGING_WRANGLER_OUTPUT_INVALID");
  const names = value.map((entry) => entry?.name);
  if (!names.every((name) => typeof name === "string" && secretName.test(name)))
    throw new StagingError("STAGING_WRANGLER_OUTPUT_INVALID");
  return [...new Set(names)].sort();
}
// `wrangler versions list --json`: ascending by created_on -> the newest version id.
export function newestVersionId(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new StagingError("STAGING_WRANGLER_OUTPUT_INVALID");
  const ids = value.map((v) => v?.id);
  if (!ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)))
    throw new StagingError("STAGING_WRANGLER_OUTPUT_INVALID");
  const sorted = [...value].sort((a, b) =>
    String(a?.metadata?.created_on ?? "").localeCompare(String(b?.metadata?.created_on ?? "")),
  );
  return sorted.at(-1).id;
}
// `gh secret list --json name,updatedAt` and `gh variable list --json name,updatedAt`.
export function githubNames(value) {
  if (!Array.isArray(value) || value.length > 256)
    throw new StagingError("STAGING_GH_OUTPUT_INVALID");
  return value.map((entry) => {
    if (typeof entry?.name !== "string" || !secretName.test(entry.name))
      throw new StagingError("STAGING_GH_OUTPUT_INVALID");
    const updatedAt =
      typeof entry.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(entry.updatedAt)
        ? entry.updatedAt
        : null;
    return { name: entry.name, updatedAt };
  });
}

// The direct Cloudflare API (the census reads, the kill switch's subdomain write, the
// queues and the Turnstile widget). Fixed base, closed path segments, no redirects,
// bounded replies. The header value comes from the opaque credential at the moment of
// the request.
export function cloudflareApi({
  credential,
  accountId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
}) {
  if (!credential || !/^[0-9a-f]{32}$/.test(accountId ?? ""))
    throw new StagingError("STAGING_CLOUDFLARE_UNCONFIGURED");
  const segment = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
  async function request(method, segments, { query = {}, body } = {}) {
    if (
      !["GET", "PATCH", "POST", "PUT"].includes(method) ||
      !segments.every((s) => segment.test(s))
    )
      throw new StagingError("STAGING_CLOUDFLARE_REQUEST_INVALID");
    const url = new URL(
      "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/" + segments.join("/"),
    );
    for (const [key, value] of Object.entries(query)) {
      if (!/^[a-z_]{1,32}$/.test(key) || !/^[A-Za-z0-9_-]{1,32}$/.test(String(value)))
        throw new StagingError("STAGING_CLOUDFLARE_REQUEST_INVALID");
      url.searchParams.set(key, String(value));
    }
    let response, text;
    try {
      response = await fetchImpl(url.href, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: credential.authorization(),
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch {
      throw new StagingError("STAGING_CLOUDFLARE_UNAVAILABLE");
    }
    if (text.length > 4 << 20) throw new StagingError("STAGING_CLOUDFLARE_RESPONSE_INVALID");
    const parsed = parseJson(text, "STAGING_CLOUDFLARE_RESPONSE_INVALID");
    if (response.status !== 200 || parsed?.success !== true)
      throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", {
        status: Number.isSafeInteger(response.status) ? response.status : null,
      });
    return parsed;
  }
  return Object.freeze({
    request,
    async get(segments, query) {
      return (await request("GET", segments, { query })).result;
    },
    // Page-numbered listings; stops at total_pages, and never past 50 pages.
    async list(segments, perPage = 50) {
      const rows = [];
      for (let page = 1; page <= 50; page++) {
        const reply = await request("GET", segments, { query: { page, per_page: perPage } });
        if (!Array.isArray(reply.result))
          throw new StagingError("STAGING_CLOUDFLARE_RESPONSE_INVALID");
        rows.push(...reply.result);
        const total = reply.result_info?.total_pages;
        if (!Number.isSafeInteger(total) || page >= total) return rows;
      }
      throw new StagingError("STAGING_CLOUDFLARE_RESPONSE_INVALID");
    },
  });
}
