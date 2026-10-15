// Offline cryptographic candidate verification only. No network, persistence,
// Morrow actor, session issuance or permission authority is supplied here.
export interface WorkosSessionTokenCandidate {
  readonly providerId: "workos";
  readonly environmentId: string;
  readonly applicationId: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly subjectId: string;
  readonly providerSessionId: string;
  readonly providerOrganizationId: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly keySetDigest: string;
}
export type WorkosSessionTokenVerification =
  | Readonly<{ outcome: "verified"; handle: object }>
  | Readonly<{ outcome: "denied"; handle: null }>;
const encoder = new TextEncoder();
const invalid = () => Error("WORKOS_SESSION_TOKEN_CONFIG_INVALID");
const denied = Object.freeze({ outcome: "denied" as const, handle: null });
const secondsLimit = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => integer(value) && value <= secondsLimit;
function paired(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw Error();
    } else if (code >= 0xdc00 && code <= 0xdfff) throw Error();
  }
}
function uniqueJson(text: string): unknown {
  // Validate duplicate decoded member names before native JSON parsing. The
  // small bounded documents also have explicit nesting/node limits.
  let at = 0,
    nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? "!")) at++;
  };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === '"') {
        const value: unknown = JSON.parse(text.slice(start, at));
        if (typeof value !== "string") throw Error();
        paired(value);
        return value;
      }
      if (character === "\\") at++;
    }
    throw Error();
  };
  const value = (depth: number): void => {
    if (++nodes > 4096 || depth > 32) throw Error();
    whitespace();
    const character = text[at];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{" || character === "[") {
      const object = character === "{",
        close = object ? "}" : "]",
        names = new Set<string>();
      at++;
      whitespace();
      if (text[at] === close) {
        at++;
        return;
      }
      while (true) {
        if (object) {
          whitespace();
          if (text[at] !== '"') throw Error();
          const name = string();
          if (names.has(name)) throw Error();
          names.add(name);
          whitespace();
          if (text[at++] !== ":") throw Error();
        }
        value(depth + 1);
        whitespace();
        if (text[at] === close) {
          at++;
          return;
        }
        if (text[at++] !== ",") throw Error();
      }
    }
    const primitive =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        text.slice(at),
      );
    if (!primitive) throw Error();
    at += primitive[0].length;
  };
  value(0);
  whitespace();
  if (at !== text.length) throw Error();
  return JSON.parse(text);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: readonly string[]) {
  const object = record(value);
  if (Object.keys(object).sort().join(",") !== [...keys].sort().join(",")) throw Error();
  return object;
}
function parse(value: unknown, maximum: number) {
  // Never inspect caller objects, proxies, boxed strings or their properties.
  if (typeof value !== "string" || value.length > maximum || encoder.encode(value).length > maximum)
    throw Error();
  paired(value);
  return uniqueJson(value);
}
function base64(value: unknown, maximum: number) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil((maximum * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  )
    throw Error();
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.length > maximum ||
    btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") !== value
  )
    throw Error();
  return bytes;
}
function decodedJson(segment: string, maximum: number) {
  return uniqueJson(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(base64(segment, maximum)),
  );
}
function publicKey(value: unknown) {
  const key = record(value),
    required = ["kty", "kid", "n", "e"],
    allowed = [...required, "alg", "use", "key_ops"];
  if (
    required.some((name) => !Object.hasOwn(key, name)) ||
    Object.keys(key).some((name) => !allowed.includes(name)) ||
    key.kty !== "RSA" ||
    typeof key.kid !== "string" ||
    !/^[\x21-\x7e]{1,128}$/.test(key.kid) ||
    (Object.hasOwn(key, "alg") && key.alg !== "RS256") ||
    (Object.hasOwn(key, "use") && key.use !== "sig") ||
    (Object.hasOwn(key, "key_ops") &&
      (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== "verify"))
  )
    throw Error();
  const modulus = base64(key.n, 512),
    exponent = base64(key.e, 3);
  if (
    modulus[0] === undefined ||
    modulus[0] === 0 ||
    (modulus[modulus.length - 1]! & 1) === 0 ||
    exponent.length !== 3 ||
    exponent[0] !== 1 ||
    exponent[1] !== 0 ||
    exponent[2] !== 1
  )
    throw Error();
  const bits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]));
  if (bits < 2048 || bits > 4096) throw Error();
  return Object.freeze({
    kty: "RSA",
    kid: key.kid,
    n: key.n as string,
    e: key.e as string,
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  });
}
async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function createWorkosSessionTokenVerifier(
  profileJson: unknown,
  jwksSnapshotJson: unknown,
  clock: () => number,
) {
  let profile: Readonly<Record<string, unknown>>, snapshot: Readonly<Record<string, unknown>>;
  let keys: readonly ReturnType<typeof publicKey>[];
  try {
    profile = Object.freeze(
      closed(parse(profileJson, 8192), [
        "schemaVersion",
        "providerId",
        "environmentId",
        "applicationId",
        "clientId",
        "issuer",
        "revision",
        "audiencePolicy",
      ]),
    );
    if (
      profile.schemaVersion !== 1 ||
      profile.providerId !== "workos" ||
      profile.audiencePolicy !== "absent" ||
      typeof profile.environmentId !== "string" ||
      !/^environment_[A-Z0-9]{26}$/.test(profile.environmentId) ||
      typeof profile.applicationId !== "string" ||
      !/^app_[A-Z0-9]{26}$/.test(profile.applicationId) ||
      typeof profile.clientId !== "string" ||
      !/^client_[A-Z0-9]{26}$/.test(profile.clientId) ||
      profile.issuer !== `https://api.workos.com/user_management/${profile.clientId}` ||
      !integer(profile.revision) ||
      profile.revision < 1 ||
      typeof clock !== "function"
    )
      throw Error();
    snapshot = Object.freeze(
      closed(parse(jwksSnapshotJson, 65536), [
        "schemaVersion",
        "profileRevision",
        "environmentId",
        "applicationId",
        "clientId",
        "observedAtMs",
        "expiresAtMs",
        "jwks",
      ]),
    );
    const jwks = closed(snapshot.jwks, ["keys"]);
    if (
      snapshot.schemaVersion !== 1 ||
      snapshot.profileRevision !== profile.revision ||
      snapshot.environmentId !== profile.environmentId ||
      snapshot.applicationId !== profile.applicationId ||
      snapshot.clientId !== profile.clientId ||
      !integer(snapshot.observedAtMs) ||
      !integer(snapshot.expiresAtMs) ||
      snapshot.expiresAtMs <= snapshot.observedAtMs ||
      snapshot.expiresAtMs - snapshot.observedAtMs > 300000 ||
      !Array.isArray(jwks.keys) ||
      !jwks.keys.length ||
      jwks.keys.length > 16
    )
      throw Error();
    keys = Object.freeze(jwks.keys.map(publicKey));
    if (new Set(keys.map((key) => key.kid)).size !== keys.length) throw Error();
  } catch {
    throw invalid();
  }
  const observedAt = snapshot.observedAtMs as number,
    leaseEnd = snapshot.expiresAtMs as number;
  let lastClock = -1,
    broken = false;
  const current = () => {
    try {
      const now = clock();
      if (broken || !integer(now) || now < lastClock) {
        broken = true;
        throw Error();
      }
      lastClock = now;
      if (now < observedAt || now >= leaseEnd) throw Error();
      return now;
    } catch {
      throw Error();
    }
  };
  try {
    current();
  } catch {
    throw invalid();
  }
  const candidates = new WeakMap<object, WorkosSessionTokenCandidate>();
  const live = (
    candidate: Pick<WorkosSessionTokenCandidate, "issuedAt" | "expiresAt">,
    now: number,
  ) => now < candidate.expiresAt * 1000 && candidate.issuedAt <= Math.floor(now / 1000) + 30;
  return Object.freeze({
    async verify(token: unknown): Promise<WorkosSessionTokenVerification> {
      try {
        const now = current();
        if (
          typeof token !== "string" ||
          !token.length ||
          token.length > 16384 ||
          !/^[A-Za-z0-9_.-]+$/.test(token)
        )
          return denied;
        const segments = token.split(".");
        if (segments.length !== 3) return denied;
        const header = record(decodedJson(segments[0]!, 2048)),
          claims = record(decodedJson(segments[1]!, 12288));
        if (
          Object.keys(header).some((name) => !["alg", "kid", "typ"].includes(name)) ||
          header.alg !== "RS256" ||
          typeof header.kid !== "string" ||
          (Object.hasOwn(header, "typ") && header.typ !== "JWT" && header.typ !== "at+jwt")
        )
          return denied;
        const key = keys.find((value) => value.kid === header.kid);
        if (
          !key ||
          claims.iss !== profile.issuer ||
          claims.client_id !== profile.clientId ||
          Object.hasOwn(claims, "aud") ||
          typeof claims.sub !== "string" ||
          !/^user_[A-Z0-9]{26}$/.test(claims.sub) ||
          typeof claims.sid !== "string" ||
          !/^session_[A-Z0-9]{26}$/.test(claims.sid) ||
          Object.hasOwn(claims, "act") ||
          ["grant_type", "gty"].some(
            (name) =>
              Object.hasOwn(claims, name) &&
              !["authorization_code", "refresh_token"].includes(claims[name] as string),
          ) ||
          (Object.hasOwn(claims, "sub_profile") && claims.sub_profile !== "user") ||
          (Object.hasOwn(claims, "org_id") &&
            (typeof claims.org_id !== "string" || !/^org_[A-Z0-9]{26}$/.test(claims.org_id))) ||
          !timestamp(claims.iat) ||
          !timestamp(claims.exp) ||
          claims.exp <= claims.iat ||
          claims.exp - claims.iat > 3600 ||
          (Object.hasOwn(claims, "nbf") &&
            (!timestamp(claims.nbf) ||
              claims.nbf >= claims.exp ||
              claims.nbf > Math.floor(now / 1000) + 30))
        )
          return denied;
        if (!live({ issuedAt: claims.iat, expiresAt: claims.exp }, now)) return denied;
        const signature = base64(segments[2], 512);
        const modulusBytes = base64(key.n, 512).length;
        if (signature.length !== modulusBytes) return denied;
        const profileDigest = await sha256(profileJson as string);
        current();
        const keySetDigest = await sha256(jwksSnapshotJson as string);
        current();
        const imported = await crypto.subtle.importKey(
          "jwk",
          key,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        current();
        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          imported,
          signature,
          encoder.encode(`${segments[0]}.${segments[1]}`),
        );
        const finishedAt = current();
        if (
          !valid ||
          !live({ issuedAt: claims.iat, expiresAt: claims.exp }, finishedAt) ||
          (timestamp(claims.nbf) && claims.nbf > Math.floor(finishedAt / 1000) + 30)
        )
          return denied;
        const candidate: WorkosSessionTokenCandidate = Object.freeze({
          providerId: "workos",
          environmentId: profile.environmentId as string,
          applicationId: profile.applicationId as string,
          clientId: profile.clientId as string,
          issuer: profile.issuer as string,
          subjectId: claims.sub,
          providerSessionId: claims.sid,
          providerOrganizationId: typeof claims.org_id === "string" ? claims.org_id : null,
          issuedAt: claims.iat,
          expiresAt: claims.exp,
          profileRevision: profile.revision as number,
          profileDigest,
          keySetDigest,
        });
        const handle = Object.freeze(Object.create(null) as object);
        candidates.set(handle, candidate);
        return Object.freeze({ outcome: "verified" as const, handle });
      } catch {
        return denied;
      }
    },
    readCandidate(handle: unknown): WorkosSessionTokenCandidate | null {
      // WeakMap lookup does not inspect a forged object or trigger proxy traps.
      if ((typeof handle !== "object" || handle === null) && typeof handle !== "function")
        return null;
      try {
        const candidate = candidates.get(handle as object);
        if (!candidate || !live(candidate, current())) return null;
        return candidate;
      } catch {
        return null;
      }
    },
  });
}
