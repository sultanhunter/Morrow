import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:https";
import { existsSync, lstatSync } from "node:fs";
import { Headers as ClientHeaders } from "undici";
import {
  createLocalLoginTlsFixture,
  createBoundedLoginCookieJar,
} from "../scripts/fixtures/login-https.mjs";

const value = Buffer.alloc(32, 1).toString("base64url");
const replacement = Buffer.alloc(32, 2).toString("base64url");
const cookie = (name = "__Host-morrow_login", age = 300, selected = value) =>
  `${name}=${selected}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const headers = (...values) => {
  const h = new Headers();
  for (const value of values) h.append("set-cookie", value);
  return h;
};
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

test("actual HTTPS trusts only synthetic CA and correct SAN; separate cookies and redirects stay separate", async () => {
  const fixture = await createLocalLoginTlsFixture();
  let calls = 0;
  const server = createServer(fixture.serverOptions, (_request, response) => {
    calls++;
    response.writeHead(303, {
      Location: "https://api.workos.com/not-followed",
      "Set-Cookie": [cookie(), cookie("__Host-morrow_session", 900)],
    });
    response.end();
  });
  try {
    assert.equal(lstatSync(fixture.directory).mode & 0o777, 0o700);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "https://127.0.0.1:" + server.address().port;
    const response = await fixture.fetch(origin + "/cookies");
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "https://api.workos.com/not-followed");
    assert.equal(response.headers.getSetCookie().length, 2);
    const jar = createBoundedLoginCookieJar();
    assert.deepEqual(jar.ingest(origin + "/cookies", response.headers), {
      accepted: 2,
      rejected: 0,
    });
    assert.equal(jar.names().length, 2);
    await response.arrayBuffer();
    await assert.rejects(fixture.untrustedFetch(origin + "/untrusted"));
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = request(
          origin + "/wrong-san",
          { ca: fixture.ca, servername: "localhost", rejectUnauthorized: true },
          (reply) => {
            reply.resume();
            resolve();
          },
        );
        req.once("error", (error) => reject(error));
        req.end();
      }),
      (error) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID",
    );
    assert.equal(calls, 1);
    assert.equal(fixture.metadata.browserEngineQualified, false);
    await assert.rejects(fixture.fetch("https://api.workos.com/user_management/authenticate"));
    await assert.rejects(fixture.fetch("http://127.0.0.1:" + server.address().port + "/"));
    assert.equal(calls, 1);
  } finally {
    await close(server);
    assert.deepEqual(await fixture.cleanup(), {
      clientsClosed: true,
      privateDirectoryAbsent: true,
    });
    assert.equal(existsSync(fixture.directory), false);
    assert.deepEqual(await fixture.cleanup(), {
      clientsClosed: true,
      privateDirectoryAbsent: true,
    });
  }
});

test("bounded jar models HTTPS host-only delivery, root path, replacement and exact age", () => {
  let at = 1000;
  const jar = createBoundedLoginCookieJar({ now: () => at });
  assert.deepEqual(
    jar.ingest("https://127.0.0.1:1234/auth/login", headers(cookie("__Host-morrow_login", 2))),
    { accepted: 1, rejected: 0 },
  );
  assert.equal(jar.header("http://127.0.0.1:1234/workspace/w/bootstrap"), undefined);
  assert.equal(jar.header("https://localhost:1234/workspace/w/bootstrap"), undefined);
  assert.equal(jar.header("https://127.0.0.2:1234/"), undefined);
  assert.equal(jar.header("https://127.0.0.1:4321/any/path"), "__Host-morrow_login=" + value);
  at = 2999;
  assert.equal(jar.names().length, 1);
  at = 3000;
  assert.deepEqual(jar.names(), []);
  jar.ingest(
    "https://127.0.0.1/auth/login",
    headers(cookie(), cookie("__Host-morrow_session", 900)),
  );
  jar.ingest(
    "https://127.0.0.1/auth/login",
    headers(cookie("__Host-morrow_login", 1, replacement)),
  );
  assert.equal(
    jar.header("https://127.0.0.1/"),
    `__Host-morrow_login=${replacement}; __Host-morrow_session=${value}`,
  );
  at = 4000;
  assert.equal(jar.header("https://127.0.0.1/"), "__Host-morrow_session=" + value);
  at = 903000;
  assert.equal(jar.header("https://127.0.0.1/"), undefined);
});

test("P05.T01y-AC28: the jar keeps a 30-minute session cookie and the exact clear removes it", () => {
  let at = 1000;
  const jar = createBoundedLoginCookieJar({ now: () => at });
  const clear = "__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
  assert.deepEqual(
    jar.ingest("https://127.0.0.1/auth/rotate", headers(cookie("__Host-morrow_session", 1801))),
    { accepted: 0, rejected: 1 },
  );
  assert.deepEqual(
    jar.ingest("https://127.0.0.1/auth/rotate", headers(cookie("__Host-morrow_session", 1800))),
    { accepted: 1, rejected: 0 },
  );
  // Single-name replacement: a newer cookie replaces the older one; the clear drops it.
  jar.ingest(
    "https://127.0.0.1/auth/rotate",
    headers(cookie("__Host-morrow_session", 1800, replacement)),
  );
  assert.equal(jar.header("https://127.0.0.1/"), "__Host-morrow_session=" + replacement);
  assert.deepEqual(jar.ingest("https://127.0.0.1/auth/logout", headers(clear)), {
    accepted: 1,
    rejected: 0,
  });
  assert.equal(jar.header("https://127.0.0.1/"), undefined);
  for (const item of [
    clear.replace("=;", "=" + value + ";"),
    clear.replace("__Host-morrow_session", "__Host-morrow_login"),
    clear.replace("; Secure", ""),
    clear + "; Domain=127.0.0.1",
  ]) {
    jar.ingest("https://127.0.0.1/", headers(cookie("__Host-morrow_session", 60)));
    assert.deepEqual(jar.ingest("https://127.0.0.1/", headers(item)), { accepted: 0, rejected: 1 });
    assert.equal(jar.header("https://127.0.0.1/"), "__Host-morrow_session=" + value);
  }
  assert.deepEqual(jar.ingest("http://127.0.0.1/auth/logout", headers(clear)), {
    accepted: 0,
    rejected: 1,
  });
  at = 1000 + 60000;
  assert.equal(jar.header("https://127.0.0.1/"), undefined);
});
test("Secure cookie from HTTP cannot be stored or treated as delivered", () => {
  const jar = createBoundedLoginCookieJar({ now: () => 1000 });
  assert.deepEqual(jar.ingest("http://127.0.0.1:1234/", headers(cookie())), {
    accepted: 0,
    rejected: 1,
  });
  assert.deepEqual(jar.names(), []);
  assert.equal(jar.header("https://127.0.0.1:1234/"), undefined);
});

test("independent malformed cookie vectors cannot update the bounded jar", () => {
  const base = cookie();
  const invalid = [
    base.replace("; Secure", ""),
    base.replace("; HttpOnly", ""),
    base.replace("SameSite=Lax", "SameSite=None"),
    base + "; Domain=127.0.0.1",
    base.replace("Path=/", "Path=/auth"),
    base + "; Secure",
    base.replace("; Secure", "; Secure=x"),
    base.replace("Max-Age=300", "Max-Age=301"),
    base.replace("Max-Age=300", "Max-Age=0"),
    base.replace("Max-Age=300", "Max-Age=01"),
    base.replace("Max-Age=300", "Max-Age=-1"),
    base + "; Expires=Wed, 01 Jan 2031 00:00:00 GMT",
    base + "; Priority=High",
    base.replace(value, '"' + value + '"'),
    base.replace(value, "%41" + value.slice(1)),
    base.replace(value, value.slice(0, 42) + "B"),
    base.replace("__Host-morrow_login", "__host-morrow_login"),
    base + ", " + cookie("__Host-morrow_session", 900),
  ];
  for (const item of invalid) {
    const jar = createBoundedLoginCookieJar({ now: () => 1000 });
    assert.deepEqual(jar.ingest("https://127.0.0.1/", headers(item)), { accepted: 0, rejected: 1 });
    assert.deepEqual(jar.names(), []);
  }
  const jar = createBoundedLoginCookieJar({ now: () => 1000 });
  assert.deepEqual(jar.ingest("https://127.0.0.1/", headers(cookie(), cookie())), {
    accepted: 0,
    rejected: 2,
  });
  assert.deepEqual(jar.names(), []);
  assert.throws(() => jar.ingest("https://127.0.0.1/", headers(cookie(), cookie(), cookie())));
});

test("standard parser accepts independent attribute order/case without weakening exact profile", () => {
  const jar = createBoundedLoginCookieJar({ now: () => 1000 }),
    h = new ClientHeaders();
  h.append(
    "set-cookie",
    `__Host-morrow_login=${value}; Max-Age=10; sAmEsItE=lAx; hTtPoNlY; sEcUrE; pAtH=/`,
  );
  assert.deepEqual(jar.ingest("https://127.0.0.1/", h), { accepted: 1, rejected: 0 });
});

test("clock regression permanently closes jar reads rather than resurrecting cookies", () => {
  let at = 1000;
  const jar = createBoundedLoginCookieJar({ now: () => at });
  jar.ingest("https://127.0.0.1/", headers(cookie()));
  at = 999;
  assert.throws(() => jar.header("https://127.0.0.1/"));
  at = 1001;
  assert.throws(() => jar.header("https://127.0.0.1/"));
  jar.clear();
});
