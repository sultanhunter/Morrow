import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { WebSocketPair } from "miniflare";
import {
  createControlledNeonTcpBridge,
  createControlledNeonTcpService,
} from "../scripts/fixtures/controlled-neon-tcp-bridge.mjs";
async function fixture(use) {
  const peers = new Set();
  const server = createServer((socket) => {
    peers.add(socket);
    socket.on("data", (data) => socket.write(data));
    socket.once("close", () => peers.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await use({ host: "127.0.0.1", port: server.address().port });
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
const pairFixture = () => {
  const pair = new WebSocketPair();
  pair[0].accept();
  pair[1].accept();
  pair[0].addEventListener("close", () => {
    if (pair[0].readyState !== 3) pair[0].close();
  });
  return pair;
};
const wait = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("TEST_TIMEOUT")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
test("transparent pair to actual loopback TCP echoes binary frames and closes both endpoints", async () =>
  fixture(async (endpoint) => {
    const pair = pairFixture();
    const client = [],
      server = [];
    const bridge = createControlledNeonTcpBridge({
      endpoint,
      socket: pair[1],
      onClientBytes: (b) => client.push(b),
      onServerBytes: (b) => server.push(b),
    });
    const received = new Promise((resolve) =>
      pair[0].addEventListener("message", (e) => resolve(new Uint8Array(e.data)), { once: true }),
    );
    pair[0].send(Uint8Array.of(0, 255, 1, 2));
    assert.deepEqual([...(await wait(received))], [0, 255, 1, 2]);
    assert.equal(client.length, 1);
    assert.equal(server.length, 1);
    pair[0].close();
    await wait(bridge.closed);
    bridge.detach();
    assert.equal(bridge.metrics.tcpClosed, true);
    assert.equal(bridge.metrics.webSocketClosed, true);
    assert.equal(bridge.metrics.transportHeld, false);
    assert.equal(bridge.metrics.timerActive, false);
  }));
test("text data and exceeded byte allowance hold without forwarding further bytes", async () =>
  fixture(async (endpoint) => {
    for (const mode of ["text", "limit"]) {
      const pair = pairFixture();
      let forwarded = 0;
      const bridge = createControlledNeonTcpBridge({
        endpoint,
        socket: pair[1],
        maximumBytes: 2,
        onClientBytes: () => forwarded++,
      });
      pair[0].send(mode === "text" ? "not binary" : Uint8Array.of(1, 2, 3));
      await wait(bridge.closed);
      bridge.detach();
      assert.equal(forwarded, 0);
      assert.equal(bridge.metrics.transportHeld, true);
    }
  }));
test("bridge refuses caller nonloopback endpoint and service denies foreign destination without opening TCP", () => {
  assert.throws(() =>
    createControlledNeonTcpBridge({ endpoint: { host: "example.com", port: 5432 }, socket: {} }),
  );
  const service = createControlledNeonTcpService({
    endpoint: { host: "127.0.0.1", port: 1 },
    hostname: "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech",
  });
  const response = service.outbound(
    new Request("https://foreign.invalid/v2?address=foreign:5432", {
      headers: { Upgrade: "websocket" },
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(service.bridges.length, 0);
  assert.equal(service.counts().deniedRequests, 1);
});

test("bounded pending writes hold instead of growing a queued TCP buffer", async () =>
  fixture(async (endpoint) => {
    const pair = pairFixture();
    const bridge = createControlledNeonTcpBridge({
      endpoint,
      socket: pair[1],
      maximumQueuedBytes: 2,
    });
    pair[0].send(Uint8Array.of(1, 2));
    pair[0].send(Uint8Array.of(3, 4));
    await wait(bridge.closed);
    bridge.detach();
    assert.equal(bridge.metrics.transportHeld, true);
    assert.equal(bridge.metrics.peakPendingBytes, 2);
    assert.equal(bridge.metrics.timerActive, false);
  }));

test("invalid socket or throwing listener setup is rejected before TCP allocation", () => {
  const endpoint = { host: "127.0.0.1", port: 1 };
  assert.throws(() => createControlledNeonTcpBridge({ endpoint, socket: {} }));
  const socket = {
    addEventListener() {
      throw Error("setup");
    },
    removeEventListener() {},
    send() {},
    close() {},
  };
  assert.throws(() => createControlledNeonTcpBridge({ endpoint, socket }));
});
