import { createHash, randomBytes, randomUUID } from "node:crypto";
import { validateDefinition } from "@morrow/contracts/validation";
import { identitySql, type IdentitySqlClient, type IdentitySqlPool } from "./index.js";

// Server-only pre-authentication primitive. It neither authenticates a user nor
// mints a session. No HTTP route, WorkOS key or exchange adapter is supplied.
export interface AuthenticationBinding {
  readonly id: string;
  readonly environmentId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly returnPath: string;
}
export class AuthenticationChallengeError extends Error {
  constructor(readonly code: "CHALLENGE_DENIED" | "CHALLENGE_UNAVAILABLE") {
    super(code);
    this.name = "AuthenticationChallengeError";
  }
}
const denied = () => new AuthenticationChallengeError("CHALLENGE_DENIED");
const unavailable = () => new AuthenticationChallengeError("CHALLENGE_UNAVAILABLE");
export const authenticationSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  create:
    "SELECT challenge_id FROM morrow_identity.begin_authentication_challenge($1::uuid,$2,$3,$4,$5,$6,$7,$8)",
  consume:
    "SELECT challenge_id FROM morrow_identity.consume_authentication_challenge($1,$2,$3,$4,$5,$6,$7)",
});
function closedStrings(value: unknown, keys: string[]): Record<string, string> {
  try {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
      throw denied();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(value);
    if (
      own.some((key) => typeof key !== "string") ||
      own.sort().join(",") !== [...keys].sort().join(",")
    )
      throw denied();
    const result: Record<string, string> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string")
        throw denied();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw denied();
  }
}
function bindingOf(input: AuthenticationBinding): AuthenticationBinding {
  const b = closedStrings(input, ["id", "environmentId", "clientId", "redirectUri", "returnPath"]);
  if (
    !validateDefinition("core", "Id", b.id) ||
    !validateDefinition("core", "Id", b.environmentId) ||
    !/^client_[A-Z0-9]{26}$/.test(b.clientId!) ||
    b.redirectUri!.length > 2048 ||
    !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(b.returnPath!) ||
    b.returnPath!.length > 512
  )
    throw denied();
  let url: URL;
  try {
    url = new URL(b.redirectUri!);
  } catch {
    throw denied();
  }
  if (
    url.href !== b.redirectUri ||
    url.username ||
    url.password ||
    b.redirectUri!.includes("*") ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw denied();
  return Object.freeze(b) as unknown as AuthenticationBinding;
}
const digest = (proof: string) => createHash("sha256").update(proof).digest("hex");
function challengeId(rows: readonly Record<string, unknown>[]): string {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    Object.keys(row).join(",") !== "challenge_id" ||
    typeof row.challenge_id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.challenge_id)
  )
    throw denied();
  return row.challenge_id;
}
async function transaction(
  pool: IdentitySqlPool,
  text: string,
  values: readonly string[],
): Promise<string> {
  let client: IdentitySqlClient;
  try {
    client = await pool.connect();
  } catch {
    throw unavailable();
  }
  let open = false,
    discard = false;
  try {
    open = true;
    await client.query(authenticationSql.begin);
    const roles = (await client.query(identitySql.role)).rows;
    if (
      roles.length !== 1 ||
      roles[0]?.role !== "morrow_api" ||
      roles[0]?.login !== "morrow_api" ||
      roles[0]?.rolsuper !== false ||
      roles[0]?.rolbypassrls !== false ||
      roles[0]?.rolcreatedb !== false ||
      roles[0]?.rolcreaterole !== false ||
      roles[0]?.owner_member !== false
    )
      throw denied();
    await client.query(identitySql.timeout);
    await client.query(identitySql.idleTimeout);
    const id = challengeId((await client.query(text, values)).rows);
    await client.query(identitySql.commit);
    open = false;
    return id;
  } catch (error) {
    if (open) {
      try {
        await client.query(identitySql.rollback);
      } catch {
        discard = true;
      }
    }
    if (error instanceof AuthenticationChallengeError) throw error;
    throw unavailable();
  } finally {
    try {
      client.release(discard);
    } catch {
      throw unavailable();
    }
  }
}
export function createAuthenticationChallenges(
  pool: IdentitySqlPool,
  input: AuthenticationBinding,
) {
  const binding = bindingOf(input);
  const configuration = [
    binding.environmentId,
    binding.clientId,
    binding.redirectUri,
    binding.returnPath,
  ];
  return Object.freeze({
    async begin() {
      // Independent 256-bit values: query state alone cannot prove this browser.
      const state = randomBytes(32).toString("base64url");
      const browserProof = randomBytes(32).toString("base64url");
      const id = randomUUID();
      const created = await transaction(pool, authenticationSql.create, [
        id,
        binding.id,
        digest(state),
        digest(browserProof),
        ...configuration,
      ]);
      if (created !== id) throw unavailable();
      // Raw proofs belong only in the browser redirect and protected challenge
      // cookie. Never log, serialize to evidence, expose to models or persist.
      return Object.freeze({ state, browserProof, maxAgeSeconds: 300 });
    },
    async consume(input: { readonly state: string; readonly browserProof: string }) {
      const proofs = closedStrings(input, ["state", "browserProof"]);
      // Canonical base64url prevents alternate encodings of one logical proof.
      for (const proof of Object.values(proofs)) {
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(proof) ||
          Buffer.from(proof, "base64url").toString("base64url") !== proof
        )
          throw denied();
      }
      const id = await transaction(pool, authenticationSql.consume, [
        binding.id,
        digest(proofs.state!),
        digest(proofs.browserProof!),
        ...configuration,
      ]);
      // Successful consume proves only this transaction. No actor/session/grant.
      return Object.freeze({ challengeId: id, binding });
    },
  });
}
