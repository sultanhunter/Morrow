// The webhook route (M2 PR-2 part of P09.T04): the raw body (at most 256 KiB) and the
// selected X-Shopify-* headers go to the broker, which checks the HMAC over the raw bytes
// before any parse. A missing header or a refused signature is 401 with no state change.
// A verified delivery is 503 until M2 PR-3 adds the durable inbox, so Shopify retries it;
// the generated app TOML subscribes no topic before PR-3, so none is delivered yet. That
// includes app/uninstalled: an uninstall before PR-3 is never delivered and its offline
// token stays active, so a development store keeps the app installed until PR-3 is
// deployed (docs/briefs/M2-shopify-connect.md, owner gates).
import {
  shopifyLimits,
  shopifyWebhookHeaderNames,
} from "../../../packages/identity/src/broker-protocol.js";

export type WebhookInput = Readonly<{ headersJson: string; rawBodyBase64: string }> | null;

export async function readWebhook(request: Request): Promise<WebhookInput> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(0|[1-9][0-9]{0,8})$/.test(declared) ||
      Number(declared) > shopifyLimits.webhookBodyMaxBytes)
  )
    return null;
  if (request.headers.has("transfer-encoding") && declared !== null) return null;
  const headers: Record<string, string> = {};
  for (const name of shopifyWebhookHeaderNames) {
    const value = request.headers.get(name);
    if (value === null || value.length === 0 || value.length > 512) return null;
    headers[name] = value;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > shopifyLimits.webhookBodyMaxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(item.value);
    }
  } catch {
    return null;
  }
  if (size === 0 || (declared !== null && Number(declared) !== size)) return null;
  let raw = "";
  for (const chunk of chunks) for (const byte of chunk) raw += String.fromCharCode(byte);
  return Object.freeze({ headersJson: JSON.stringify(headers), rawBodyBase64: btoa(raw) });
}
