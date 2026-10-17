// U01 generic platform fixture. Deliberately imports no production module.
type Environment = { NONCE: string };
type Context = { waitUntil(promise: Promise<unknown>): void };
const ownerBody = "u01-finite-owner";
export default {
  async fetch(request: Request, env: Environment, ctx: Context): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      request.method !== "GET" ||
      !["/positive", "/negative"].includes(path) ||
      !/^[a-f0-9]{32}$/.test(env.NONCE)
    )
      return new Response("refused", { status: 400 });
    const base = `https://morrow-cleanup-gate.test/${env.NONCE}`;
    const completion = fetch(base + "/gate", { redirect: "manual" }).then(async (gate) => {
      if (gate.status !== 200 || (await gate.text()) !== "u01-opened-gate")
        throw Error("U01_GATE_REFUSED");
      const marker = await fetch(base + "/complete", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "u01-gate-read",
        redirect: "manual",
      });
      if (marker.status !== 200 || (await marker.text()) !== "u01-marker-ack")
        throw Error("U01_MARKER_REFUSED");
    });
    // The sink is deliberately not the object passed to waitUntil.
    void completion.catch(() => {});
    if (path === "/positive") ctx.waitUntil(completion);
    const admitted = await fetch(base + "/accepted", { redirect: "manual" });
    if (admitted.status !== 200 || (await admitted.text()) !== "u01-admitted")
      throw Error("U01_ADMISSION_REFUSED");
    // No gate await, timer, streaming response or other retained task here.
    return new Response(ownerBody, {
      status: 200,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  },
};
