// Cloudflare token isolation for the staging tools (P04.T01i D2, ADR-0019 item 14).
// scripts/staging.mjs imports this module FIRST, so it runs before any other module of
// the tool is evaluated: it moves CLOUDFLARE_API_TOKEN out of process.env into this
// closure and deletes every other Cloudflare credential variable, which the tools never
// accept. The token then reaches only (a) the environment of a wrangler child, the one
// way wrangler accepts it, and (b) the Authorization header of a direct Cloudflare API
// request made by the tool itself. It never reaches argv, a file, a log, an error, a
// report or a JSON serialisation. The deploy workflow's GH_TOKEN (its GITHUB_TOKEN, with
// contents: read and actions: read) is moved out of process.env the same way and reaches
// only gh children. This module imports only node: builtins.
import { inspect } from "node:util";

const captured =
  typeof process.env.CLOUDFLARE_API_TOKEN === "string" && process.env.CLOUDFLARE_API_TOKEN !== ""
    ? process.env.CLOUDFLARE_API_TOKEN
    : null;
delete process.env.CLOUDFLARE_API_TOKEN;
const capturedGithub =
  typeof process.env.GH_TOKEN === "string" && process.env.GH_TOKEN !== ""
    ? process.env.GH_TOKEN
    : null;
delete process.env.GH_TOKEN;
// Never used, never relayed: their presence is reported by name only, then refused.
const refusedNames = Object.freeze(
  ["CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN", "CF_API_KEY", "CF_EMAIL"].filter(
    (name) => typeof process.env[name] === "string" && process.env[name] !== "",
  ),
);
for (const name of [
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
])
  delete process.env[name];

// Cloudflare API tokens are 40 URL-safe characters; allow a longer future form.
export const cloudflareTokenFormat = /^[A-Za-z0-9_-]{40,160}$/;

export const environmentTokenPresent = () => captured !== null;
export const refusedCredentialVariables = () => refusedNames;

class StagingTokenError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// An opaque credential: its only outputs are a child environment and a header value.
function credential(token) {
  if (typeof token !== "string" || !cloudflareTokenFormat.test(token))
    throw new StagingTokenError("STAGING_TOKEN_FORMAT");
  const handle = {
    childEnvironment(base) {
      return { ...base, CLOUDFLARE_API_TOKEN: token };
    },
    authorization() {
      return "Bearer " + token;
    },
    toJSON() {
      return "[cloudflare credential]";
    },
    toString() {
      return "[cloudflare credential]";
    },
    [inspect.custom]() {
      return "[cloudflare credential]";
    },
  };
  return Object.freeze(handle);
}

// `source` is "environment" in the one CI step that holds the token, or "operator-file"
// for local runs, where the token comes only from the owner's file through
// `readOperatorToken` (scripts/staging-files.mjs). A local run with a token in its
// environment is refused rather than guessed at.
export function cloudflareCredential({ source, readOperatorToken }) {
  if (refusedNames.length) throw new StagingTokenError("STAGING_CLOUDFLARE_VARIABLE_REFUSED");
  if (source === "environment") {
    if (captured === null) throw new StagingTokenError("STAGING_TOKEN_MISSING");
    return credential(captured);
  }
  if (source === "operator-file") {
    if (captured !== null) throw new StagingTokenError("STAGING_TOKEN_IN_ENVIRONMENT");
    if (typeof readOperatorToken !== "function")
      throw new StagingTokenError("STAGING_TOKEN_MISSING");
    return credential(readOperatorToken());
  }
  throw new StagingTokenError("STAGING_TOKEN_SOURCE_INVALID");
}

// Tests only: a credential over a synthetic marker token, through the same wrapper.
export const syntheticCredential = (token) => credential(token);

// The GH_TOKEN captured at startup, as an opaque handle whose only output is a gh child's
// environment; null when none was set (locally gh uses the operator's own login).
function githubHandle(token) {
  return Object.freeze({
    childEnvironment(base) {
      return { ...base, GH_TOKEN: token };
    },
    toJSON() {
      return "[github credential]";
    },
    toString() {
      return "[github credential]";
    },
    [inspect.custom]() {
      return "[github credential]";
    },
  });
}
export const githubCredential = () =>
  capturedGithub === null ? null : githubHandle(capturedGithub);
// Tests only.
export const syntheticGithubCredential = (token) => githubHandle(token);
