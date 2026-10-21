import "@shopify/shopify-app-react-router/adapters/node";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
// Development-only React Router scaffold (P04.T02a); never deployed. The deployed connector is
// worker/index.ts, which uses no Shopify library and binds no secret (ADR-0008 as amended
// 2026-10-20). Its MVP apps are custom distribution per beta development store with
// non-expiring offline tokens (ADR-0022 item 4), unlike the App Store options below.
type ShopifyOptions = Parameters<typeof shopifyApp>[0];
/** Composition root only. P04/P09 supply qualified durable storage/authentication. */
export function createShopifyIntegration(
  config: { apiKey: string; apiSecretKey: string; appUrl: string; scopes: string[] },
  sessionStorage: NonNullable<ShopifyOptions["sessionStorage"]>,
) {
  if (!config.apiKey || !config.apiSecretKey || !config.appUrl.startsWith("https://"))
    throw new Error("Qualified Shopify configuration required");
  return shopifyApp({
    ...config,
    sessionStorage,
    apiVersion: ApiVersion.October26,
    authPathPrefix: "/auth",
    distribution: AppDistribution.AppStore,
    isEmbeddedApp: false,
    future: { expiringOfflineAccessTokens: true },
  });
}
