import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  realpathSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Headers as ClientHeaders, fetch as clientFetch, getSetCookies } from "undici";

// Synthetic qualification only. No host trust installation, provider endpoint,
// arbitrary credential, insecure TLS fallback, automatic redirect or real user.
const fail = () => Error("LOGIN_HTTPS_FIXTURE_HELD");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const time = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const secret = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const caps = new Map([
  ["__Host-morrow_login", 300],
  // P05.T01y: a session generation lives at most 30 idle minutes (ADR-0004).
  ["__Host-morrow_session", 1800],
]);
// The exact logout clear (P05.T01y). RFC 6265bis: a cookie whose Max-Age is zero replaces
// the stored cookie of the same name, host and path and is then removed, so the jar
// deletes the session cookie. No other Max-Age=0 field is accepted.
const sessionClear = "__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

/** An intentionally bounded two-cookie qualification jar, not a browser engine. */
export function createBoundedLoginCookieJar({ now = Date.now } = {}) {
  if (typeof now !== "function") throw fail();
  const stored = new Map();
  let previous = -1,
    broken = false;
  const clock = () => {
    const at = now();
    if (broken || !time(at) || at < previous) {
      broken = true;
      throw fail();
    }
    previous = at;
    return at;
  };
  const address = (value) => {
    if (typeof value !== "string" || value.length > 2048) throw fail();
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw fail();
    return url;
  };
  return Object.freeze({
    ingest(value, headers) {
      const url = address(value),
        at = clock();
      if (!(headers instanceof Headers) && !(headers instanceof ClientHeaders)) throw fail();
      const raw = headers.getSetCookie();
      if (!Array.isArray(raw) || raw.length > 2) throw fail();
      // Undici's locked standard parser preserves separate header fields. It
      // does not implement storage, prefix, Secure, host/path or age policies.
      const parsed = getSetCookies(headers),
        seen = new Set();
      let accepted = 0,
        rejected = 0;
      const prepared = [];
      for (let i = 0; i < raw.length; i++) {
        const text = raw[i],
          cookie = parsed[i];
        if (
          text === sessionClear &&
          url.protocol === "https:" &&
          url.hostname === "127.0.0.1" &&
          !seen.has("__Host-morrow_session")
        ) {
          seen.add("__Host-morrow_session");
          prepared.push(["__Host-morrow_session", null]);
          accepted++;
          continue;
        }
        const pieces = typeof text === "string" ? text.split(";") : [];
        const pair = pieces[0];
        const attributes = pieces
          .slice(1)
          .map((part) => part.trim().split("=", 1)[0].toLowerCase());
        const unique = new Set(attributes);
        const expected = ["path", "secure", "httponly", "samesite", "max-age"];
        const attributeProfile = pieces
          .slice(1)
          .every((part) =>
            /^(?:Path=\/|Secure|HttpOnly|SameSite=Lax|Max-Age=[1-9][0-9]{0,3})$/i.test(part.trim()),
          );
        if (
          !cookie ||
          typeof text !== "string" ||
          text.length > 4096 ||
          /[^\x20-\x7e]/.test(text) ||
          url.protocol !== "https:" ||
          url.hostname !== "127.0.0.1" ||
          !caps.has(cookie.name) ||
          seen.has(cookie.name) ||
          !secret(cookie.value) ||
          pair !== cookie.name + "=" + cookie.value ||
          attributes.length !== expected.length ||
          unique.size !== expected.length ||
          !expected.every((name) => unique.has(name)) ||
          !attributeProfile ||
          cookie.secure !== true ||
          cookie.httpOnly !== true ||
          cookie.sameSite !== "Lax" ||
          cookie.path !== "/" ||
          cookie.domain !== undefined ||
          cookie.expires !== undefined ||
          cookie.unparsed?.length ||
          !Number.isSafeInteger(cookie.maxAge) ||
          cookie.maxAge < 1 ||
          cookie.maxAge > caps.get(cookie.name) ||
          !time(at + cookie.maxAge * 1000)
        ) {
          rejected++;
          continue;
        }
        seen.add(cookie.name);
        prepared.push([
          cookie.name,
          Object.freeze({
            value: cookie.value,
            hostname: url.hostname,
            path: "/",
            expiresAtMs: at + cookie.maxAge * 1000,
          }),
        ]);
        accepted++;
      }
      // A malformed/combined/duplicated field never partially updates the jar.
      if (rejected) return Object.freeze({ accepted: 0, rejected: raw.length });
      for (const [name, cookie] of prepared)
        if (cookie === null) stored.delete(name);
        else stored.set(name, cookie);
      return Object.freeze({ accepted, rejected });
    },
    header(value) {
      const url = address(value),
        at = clock();
      const eligible = [];
      for (const [name, cookie] of stored) {
        if (at >= cookie.expiresAtMs) {
          stored.delete(name);
          continue;
        }
        if (
          url.protocol === "https:" &&
          url.hostname === cookie.hostname &&
          url.pathname.startsWith(cookie.path)
        )
          eligible.push(name + "=" + cookie.value);
      }
      return eligible.length ? eligible.join("; ") : undefined;
    },
    names() {
      const at = clock();
      for (const [name, cookie] of stored) if (at >= cookie.expiresAtMs) stored.delete(name);
      return Object.freeze([...stored.keys()].sort());
    },
    clear() {
      stored.clear();
    },
  });
}

export async function createLocalLoginTlsFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "morrow-login-tls-")));
  const owned = lstatSync(directory);
  const file = (name, content = "") => {
    const path = join(directory, name);
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    return path;
  };
  const caKey = file("ca.key"),
    caCertificate = file("ca.pem"),
    serverKey = file("server.key"),
    serverRequest = file("server.csr"),
    serverCertificate = file("server.pem"),
    extensions = file(
      "server.ext",
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n",
    );
  let trusted,
    untrusted,
    closed = false,
    cleanupPromise;
  let key, cert, ca;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    closed = true;
    cleanupPromise = (async () => {
      const agents = [trusted, untrusted].filter(Boolean);
      const results = await Promise.allSettled(agents.map((agent) => agent.close()));
      if (key) key.fill(0);
      const current = lstatSync(directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.uid !== owned.uid ||
        current.dev !== owned.dev ||
        current.ino !== owned.ino ||
        (current.mode & 0o777) !== 0o700 ||
        realpathSync(directory) !== directory
      )
        throw fail();
      rmSync(directory, { recursive: true });
      if (existsSync(directory) || results.some((result) => result.status === "rejected"))
        throw fail();
      return Object.freeze({ clientsClosed: true, privateDirectoryAbsent: true });
    })();
    return cleanupPromise;
  };
  const run = (args) => {
    const result = spawnSync(process.platform === "darwin" ? "/usr/bin/openssl" : "openssl", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
      maxBuffer: 65536,
      encoding: "utf8",
      env: { PATH: process.env.PATH, LANG: "C" },
    });
    if (result.error || result.status !== 0 || result.signal !== null) throw fail();
  };
  try {
    run([
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=Morrow Synthetic Test CA",
      "-keyout",
      caKey,
      "-out",
      caCertificate,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    run([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      serverKey,
      "-out",
      serverRequest,
    ]);
    run([
      "x509",
      "-req",
      "-in",
      serverRequest,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-set_serial",
      "1",
      "-out",
      serverCertificate,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensions,
    ]);
    for (const name of [
      caKey,
      caCertificate,
      serverKey,
      serverRequest,
      serverCertificate,
      extensions,
    ]) {
      const info = lstatSync(name);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600
      )
        throw fail();
    }
    key = readFileSync(serverKey);
    cert = readFileSync(serverCertificate);
    ca = readFileSync(caCertificate);
    const certificate = new X509Certificate(cert),
      root = new X509Certificate(ca);
    if (
      !root.ca ||
      certificate.ca ||
      certificate.checkIP("127.0.0.1") !== "127.0.0.1" ||
      !certificate.verify(root.publicKey) ||
      certificate.checkHost("localhost") !== undefined
    )
      throw fail();
    trusted = new Agent({ connect: { ca, rejectUnauthorized: true }, connections: 2 });
    untrusted = new Agent({ connect: { rejectUnauthorized: true }, connections: 1 });
    const request =
      (agent) =>
      async (value, init = {}) => {
        if (closed || typeof value !== "string") throw fail();
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "127.0.0.1" ||
          !url.port ||
          url.username ||
          url.password ||
          url.hash ||
          Object.keys(init).some((name) => !["method", "headers", "body", "signal"].includes(name))
        )
          throw fail();
        return clientFetch(value, { ...init, dispatcher: agent, redirect: "manual" });
      };
    return Object.freeze({
      directory,
      ca,
      serverOptions: Object.freeze({ key, cert, minVersion: "TLSv1.2" }),
      fetch: request(trusted),
      untrustedFetch: request(untrusted),
      cleanup,
      metadata: Object.freeze({
        parserPackage: "undici",
        parserVersion: "7.29.1",
        san: "IP:127.0.0.1",
        certificateSha256: digest(cert),
        caCertificateSha256: digest(ca),
        tlsValidation: "explicit_ca_and_default_hostname_validation",
        browserEngineQualified: false,
      }),
    });
  } catch {
    await cleanup();
    throw fail();
  }
}
