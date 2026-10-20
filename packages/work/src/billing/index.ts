// @morrow/work/billing (M5 PR-1): the Morrow-direct billing server. The SQL facts reader
// (createBillingFactsReader, with the billing period M3 keys its unrecovered-cost ledger
// on), the terms table, the purchase guard and routes, the receipt application planner,
// the Stripe webhook handler, and the pure Stripe object shapes shared with the broker.
export {
  accountFromRow,
  associationFromRow,
  billingFactsInput,
  conflictFromRow,
  createBillingFactsReader,
  intentFromRow,
  periodFromRow,
  snapshotFromRow,
  walletFromRow,
  BillingFactsRowError,
  type BillingAssociation,
  type BillingFactsRead,
  type BillingIntentView,
  type BillingPeriod,
  type BillingQuery,
  type BillingRecords,
  type BillingWallet,
} from "./facts.js";
export {
  parseTermsDocument,
  subscriptionEntry,
  termsDocumentDigest,
  termsFromRow,
  BillingTermsError,
  type BillingOffer,
  type BillingTermsEntry,
  type BillingTermsRevision,
} from "./terms.js";
export {
  guardPurchase,
  isMorrowPurchaseRoute,
  morrowPurchaseRoutes,
  type MorrowPurchaseRouteKey,
  type PurchaseGuardResult,
} from "./purchase-guard.js";
export {
  authorizeBillingView,
  authorizePurchase,
  BillingCommandRejected,
  BillingDenied,
  billingRequestDigest,
  currentOffers,
  decideBilling,
  openCheckout,
  openPortal,
  parseCheckoutBody,
  parsePortalBody,
  readBillingContext,
  requirePurchase,
  type BillingBrokerPort,
  type BillingCommandRejection,
  type BillingContext,
  type CheckoutOpened,
} from "./commands.js";
export {
  parseReceiptFacts,
  paymentEventFor,
  planReceiptApplication,
  receiptModeAccepted,
  subscriptionValidUntil,
  ReceiptPlanError,
  type BegunReceipt,
  type ReceiptFacts,
  type ReceiptOutcome,
  type ReceiptPlan,
} from "./apply-plan.js";
export {
  billingBodyLimitBytes,
  billingDenialResponse,
  billingRoutes,
  createBillingApiHandler,
  type BillingApiDependencies,
  type BillingRoute,
} from "./http.js";
export {
  base64Bytes,
  createStripeWebhookHandler,
  stripeWebhookLimits,
  stripeWebhookPath,
  type StripeWebhookDependencies,
} from "./webhook.js";
export { billingStatements, type BillingStatementName } from "./sql.js";
export * from "./stripe-objects.js";
