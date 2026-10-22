// A scripted stand-in for the Messages API (M3 PR-2 labs): a fetch function that answers the
// broker's Claude adapter in-process. Nothing leaves the machine; the key it accepts is a
// synthetic one built at runtime. It checks every request the adapter sends (the endpoint,
// the exact headers, the exact body key set, adaptive thinking, the effort and the strict
// output schema, and that the counting body is the message body without max_tokens), and
// answers each product's calls from a script keyed by product id:
//   {kind: "completed", draft?, usage?}   200 end_turn with the draft as JSON text
//   {kind: "stop", reason}                200 with that stop reason (max_tokens, refusal, ...)
//   {kind: "invalid_json"}                200 end_turn whose text is not JSON
//   {kind: "other_model"}                 200 naming another model (no fallback)
//   {kind: "status", status, retryAfter?, type?, message?}   an error reply
//   {kind: "throw"}                       a transport failure
// Any step may carry `before`, an async hook run while the request is in flight.
// The count of each product answers {tokens} (default 900) or a status. Unscripted calls
// complete. Every request is recorded (path, product id, the adapter's body) for the lab's
// checks; no provider text is ever produced except these synthetic drafts.
import { randomBytes } from "node:crypto";

export const oracleOrigin = "https://api.anthropic.com";
export const fakeAnthropicKey = () =>
  "sk-ant-api03-" + randomBytes(66).toString("base64url").slice(0, 88);
const bodyKeys = "max_tokens,messages,model,output_config,system,thinking";
const countKeys = "messages,model,output_config,system,thinking";

export function createAnthropicOracle({ key, models }) {
  const requests = [];
  const violations = [];
  const scripts = new Map();
  const counts = new Map();
  const served = new Map();
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const productOf = (body) => {
    const text = body?.messages?.[0]?.content;
    const at = typeof text === "string" ? text.lastIndexOf("Product (JSON):\n") : -1;
    if (at < 0) return null;
    try {
      return JSON.parse(text.slice(at + "Product (JSON):\n".length));
    } catch {
      return null;
    }
  };
  const fieldsOf = (body) => {
    const m = /Fields to improve: ([^\n]*)/.exec(body?.messages?.[0]?.content ?? "");
    return m ? m[1].split(", ") : [];
  };
  // The default draft: every requested field changed, every other field null.
  const draftFor = (product, fields) => ({
    productId: product.productId,
    title: fields.includes("title") ? product.title + " - improved" : null,
    descriptionHtml: fields.includes("descriptionHtml")
      ? "<p>A clearer description of " + product.productId + ".</p>"
      : null,
    seo: fields.includes("seo.title")
      ? { title: "SEO " + product.productId, description: "Better SEO text." }
      : null,
    tags: fields.includes("tags") ? [...product.tags, "improved"] : null,
  });
  async function fetch(request) {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    let body = null;
    try {
      body = JSON.parse(await request.text());
    } catch {
      violations.push("body_not_json");
    }
    const path = url.pathname;
    const product = productOf(body);
    const id = product?.productId ?? null;
    requests.push({ path, productId: id, model: body?.model ?? null });
    if (url.origin !== oracleOrigin || request.method !== "POST") violations.push("endpoint");
    if (
      Object.keys(headers).sort().join(",") !== "anthropic-version,content-type,x-api-key" ||
      headers["x-api-key"] !== key ||
      headers["anthropic-version"] !== "2023-06-01" ||
      headers["content-type"] !== "application/json"
    )
      violations.push("headers");
    const keys = body ? Object.keys(body).sort().join(",") : "";
    if (
      !body ||
      !models.includes(body.model) ||
      body.thinking?.type !== "adaptive" ||
      Object.keys(body.thinking).length !== 1 ||
      !["low", "medium", "high"].includes(body.output_config?.effort) ||
      body.output_config?.format?.type !== "json_schema" ||
      body.output_config?.format?.schema?.additionalProperties !== false ||
      !Array.isArray(body.messages) ||
      body.messages.length !== 1 ||
      body.messages[0].role !== "user" ||
      product === null
    )
      violations.push("body");
    if (path === "/v1/messages/count_tokens") {
      if (keys !== countKeys) violations.push("count_keys");
      const answer = counts.get(id) ?? { tokens: 900 };
      if (answer.status)
        return json(answer.status, { type: "error", error: { type: "x", message: "" } });
      return json(200, { input_tokens: answer.tokens });
    }
    if (path !== "/v1/messages") {
      violations.push("path");
      return json(404, { type: "error", error: { type: "not_found_error", message: "" } });
    }
    if (keys !== bodyKeys) violations.push("message_keys");
    const queue = scripts.get(id) ?? [];
    const n = served.get(id) ?? 0;
    served.set(id, n + 1);
    const step = queue[n] ?? { kind: "completed" };
    // A lab hook that runs while the request is in flight (e.g. a stop landing mid-call).
    await step.before?.();
    const requestId = "req_lab" + randomBytes(8).toString("hex");
    const usage = step.usage ?? { input_tokens: 900, output_tokens: 300 };
    const reply = (over) =>
      json(
        200,
        {
          id: "msg_lab",
          type: "message",
          role: "assistant",
          model: body.model,
          stop_reason: "end_turn",
          content: [{ type: "text", text: "{}" }],
          usage,
          ...over,
        },
        { "request-id": requestId },
      );
    switch (step.kind) {
      case "completed": {
        const draft = step.draft ? step.draft(product) : draftFor(product, fieldsOf(body));
        return reply({ content: [{ type: "text", text: JSON.stringify(draft) }] });
      }
      case "stop":
        return reply({ stop_reason: step.reason });
      case "invalid_json":
        return reply({ content: [{ type: "text", text: "not json" }] });
      case "other_model":
        return reply({ model: "claude-other-model" });
      case "status":
        return json(
          step.status,
          {
            type: "error",
            error: { type: step.type ?? "api_error", message: step.message ?? "" },
          },
          step.retryAfter === undefined
            ? { "request-id": requestId }
            : { "request-id": requestId, "retry-after": step.retryAfter },
        );
      case "throw":
        throw new TypeError("network");
      default:
        throw Error("ORACLE_SCRIPT_INVALID");
    }
  }
  return Object.freeze({
    fetch,
    requests,
    violations,
    /** The answers to one product's sends, in order. */
    script(productId, steps) {
      scripts.set(productId, [...steps]);
      served.set(productId, 0);
    },
    count(productId, answer) {
      counts.set(productId, answer);
    },
    sends: (productId) =>
      requests.filter((r) => r.path === "/v1/messages" && r.productId === productId).length,
  });
}
