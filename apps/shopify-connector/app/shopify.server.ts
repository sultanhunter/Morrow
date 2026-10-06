import "@shopify/shopify-app-react-router/adapters/node";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
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
