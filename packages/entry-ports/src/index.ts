export type EntrySurface = "standalone" | "shopify_connector";
/** Server authentication must supply this port; client values confer no authority. */
export interface AuthenticatedEntryPort {
  authenticate(request: Request): Promise<Response>;
}
