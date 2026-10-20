// The api's view of the broker's Stripe methods and the billing environment (M5 PR-1).
// Kept free of @morrow/policy types, so the api Worker's edge typecheck consumes the
// billing handlers' declarations without the DOM-typed policy sources.
export type BillingEnvironmentName = "development" | "staging" | "production";

/** The broker's Stripe methods as the api sees them (apps/api/src/broker-client.ts). */
export interface BillingBrokerPort {
  customerEnsure(
    operationId: string,
    signal: AbortSignal,
  ): Promise<{ readonly outcome: "verified" | "failed" | "uncertain" }>;
  checkoutCreate(
    operationId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly outcome: "verified" | "failed" | "uncertain" | "closed" | "pending";
    readonly checkoutUrl: string | null;
    readonly expiresAtMs: number | null;
  }>;
  portalCreate(
    operationId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly outcome: "verified" | "failed" | "uncertain";
    readonly portalUrl: string | null;
  }>;
  webhookVerify(
    rawBodyBase64: string,
    signatureHeader: string,
    signal: AbortSignal,
  ): Promise<{
    readonly verdict: "recorded" | "duplicate" | "rejected" | "ignored";
    readonly receiptId: string | null;
    readonly objectDigest: string | null;
    readonly attributed: boolean | null;
  }>;
}
