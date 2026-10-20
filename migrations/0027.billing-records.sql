BEGIN;
-- M5 PR-1 billing records (docs/briefs/M5-billing.md; ADR-0015; ADR-0022 items 2, 9, 11
-- and 12 with the 2026-10-20 amendments to items 9 and 11; billing-entitlements.md
-- persistence items 3-8). Executes AS morrow_work_owner, after 0026. On the ADR-0010
-- tenant pattern: composite tenant keys, ENABLE and FORCE RLS everywhere, definers owned by
-- morrow_work_command, INVOKER triggers and helpers owned by the owner.
--   * billing_terms: Morrow's versioned terms table (BillingTerms@1, R10) with display
--     offers, seeded by the owner (staging:seed-platform); append-only and immutable.
--   * Stripe operations: the purpose of each stripe_write operation (morrow_work.operations,
--     0020; kind stripe_write, task null, capability governance.billing.manage), the
--     workspace's Stripe customer mapping and its checkout intents (one open per workspace).
--   * Receipts: verified Stripe events recorded by the broker's own login with the
--     normalised object and its digest; their application records; the entry proof of the
--     receipt context.
--   * The ledger: billing_accounts (BillingAccount@2), entitlement_snapshots
--     (EntitlementSnapshot@2), verified_payment_events (VerifiedPaymentEvent@1),
--     credit_grants (CreditGrant@2, unique per route, mode and payment key, no expiry in the
--     beta) and credit_wallets (CreditWallet@1, funded only by a grant of the same
--     transaction, otherwise moved with its sum kept).
-- Three entries, each with its own definers (ADR-0022 item 9 amendment, 2026-10-20):
--   * session commands for morrow_work_api: the checkout and portal commands and the
--     association read; the tenant only from current_tenant();
--   * the broker's login (morrow_vault_broker): the Stripe operation send fence and settle
--     and the receipt record; the tenant of a receipt only from the customer mapping;
--   * the api login's receipt-only ingress (morrow_work_api, session_user
--     morrow_api_worker with no work session context): receipt_begin, receipt_apply and
--     receipt_status. They accept only a recorded receipt with a matching digest, take the
--     tenant from it and re-derive the payment key, mode and credit units in SQL. The api
--     login never inserts or changes a receipt or a customer mapping, and the broker login
--     never applies a payment, fixes a route or grants credits.
-- No definer here sends anything; the broker calls Stripe between its own definers.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_billing.workspace_billing_routes') IS NULL OR to_regclass('morrow_work.operations') IS NULL
 OR to_regprocedure('morrow_work.operation_transition(text,text,text,bigint,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL OR to_regprocedure('morrow_work.db_now()') IS NULL
 OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.append_only()') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_lock_and_recheck(text,text,text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_store_installations(text,text)','EXECUTE')
 OR to_regclass('morrow_billing.billing_terms') IS NOT NULL OR to_regclass('morrow_billing.credit_wallets') IS NOT NULL
 OR (SELECT count(*) FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_work' AND p.tablename IN ('operations','operation_transitions')
   AND p.policyname LIKE 'broker\_%')<>0
 OR NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules t WHERE t.machine='operation' AND t.from_status='authorized' AND t.to_status='dispatching'
   AND t.actor='action_service' AND t.guard='non_billable_current_grants_and_lease')
 THEN RAISE EXCEPTION 'BILLING_RECORDS_PREREQUISITES_INVALID'; END IF;
END $$;

-- The broker's own login reaches its three billing definers.
GRANT USAGE ON SCHEMA morrow_billing TO morrow_vault_broker;

-- ---------------------------------------------------------------------------
-- Platform: the terms table. One row per BillingTerms@1 revision (R10: the only source of
-- credit units), its display offers and the digest docs/decisions/billing-terms.json
-- publishes (JCS SHA-256 of {terms, offers}). Revisions are contiguous; a row never changes.
CREATE TABLE morrow_billing.billing_terms (
 terms_revision morrow_work.revision NOT NULL PRIMARY KEY,
 terms jsonb NOT NULL CHECK (jsonb_typeof(terms)='object' AND terms->'schemaVersion'='1'::jsonb
  AND jsonb_typeof(terms->'entries')='array' AND jsonb_typeof(terms->'planChanges')='array' AND pg_column_size(terms)<=65536),
 offers jsonb NOT NULL CHECK (jsonb_typeof(offers)='array' AND jsonb_array_length(offers) BETWEEN 1 AND 20),
 digest morrow_work.digest NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=timestamptz '2000-01-01T00:00:00Z' AND recorded_at<timestamptz '9000-01-01T00:00:00Z'),
 CONSTRAINT billing_terms_revision CHECK (terms->>'termsRevision'=terms_revision::text)
);

-- The workspace's one Stripe customer, recorded when the broker settles the customer
-- operation the workspace's session-authorised checkout created. Never changes.
CREATE TABLE morrow_billing.stripe_customers (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 stripe_customer_id text NOT NULL CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{8,100}$'),
 mode text NOT NULL CHECK (mode IN ('live','test')),
 created_by_operation_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id),
 UNIQUE (stripe_customer_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,created_by_operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id)
);

-- One Morrow checkout of one priced plan (§8.7): the intent the session's command opened,
-- with its customer and checkout operations. At most one open or completed intent per
-- workspace; no checkout or portal URL is stored (ADR-0022 item 13).
CREATE TABLE morrow_billing.checkout_intents (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 status text NOT NULL CHECK (status IN ('open','completed','verified','expired','failed')),
 price_key text NOT NULL CHECK (price_key ~ '^stripe:price:price_[A-Za-z0-9]{8,100}$'),
 terms_revision morrow_work.revision NOT NULL REFERENCES morrow_billing.billing_terms(terms_revision),
 route_revision morrow_work.revision NOT NULL,
 mode text NOT NULL CHECK (mode IN ('live','test')),
 actor_principal_id morrow_work.record_id NOT NULL,
 actor_membership_id morrow_work.record_id NOT NULL,
 idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 request_digest morrow_work.digest NOT NULL,
 correlation_id morrow_work.record_id NOT NULL,
 customer_operation_id morrow_work.record_id,
 checkout_operation_id morrow_work.record_id NOT NULL,
 stripe_session_id text CHECK (stripe_session_id ~ '^cs_[A-Za-z0-9_]{8,250}$'),
 expires_at timestamptz NOT NULL CHECK (expires_at=date_trunc('second',expires_at) AND isfinite(expires_at)),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,actor_principal_id,idempotency_key),
 UNIQUE (organization_id,workspace_id,checkout_operation_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,workspace_id,customer_operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,checkout_operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id),
 CONSTRAINT checkout_intents_times CHECK (updated_at>=created_at AND expires_at>created_at)
);
CREATE UNIQUE INDEX checkout_intents_one_open ON morrow_billing.checkout_intents (organization_id,workspace_id) WHERE status IN ('open','completed');

-- The purpose of one stripe_write operation. Checkout and customer operations name the
-- intent they serve; a portal operation carries its own command key and digest (replay).
CREATE TABLE morrow_billing.stripe_operations (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 operation_id morrow_work.record_id NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('customer_create','checkout_session_create','portal_session_create')),
 checkout_intent_id morrow_work.record_id,
 actor_principal_id morrow_work.record_id NOT NULL,
 actor_membership_id morrow_work.record_id NOT NULL,
 idempotency_key text CHECK (idempotency_key ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 request_digest morrow_work.digest,
 correlation_id morrow_work.record_id NOT NULL,
 provider_object_id text CHECK (provider_object_id ~ '^(cus|cs|bps)_[A-Za-z0-9_]{8,250}$'),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,operation_id),
 UNIQUE (organization_id,workspace_id,actor_principal_id,idempotency_key),
 FOREIGN KEY (organization_id,workspace_id,operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,checkout_intent_id) REFERENCES morrow_billing.checkout_intents(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT stripe_operations_purpose CHECK (CASE purpose
  WHEN 'portal_session_create' THEN checkout_intent_id IS NULL AND idempotency_key IS NOT NULL AND request_digest IS NOT NULL
   AND (provider_object_id IS NULL OR provider_object_id ~ '^bps_')
  WHEN 'checkout_session_create' THEN checkout_intent_id IS NOT NULL AND idempotency_key IS NULL AND request_digest IS NULL
   AND (provider_object_id IS NULL OR provider_object_id ~ '^cs_')
  ELSE checkout_intent_id IS NOT NULL AND idempotency_key IS NULL AND request_digest IS NULL
   AND (provider_object_id IS NULL OR provider_object_id ~ '^cus_') END)
);

-- One verified Stripe event (ADR-0022 item 12's six types), recorded by the broker after
-- the signature check and a readback of its object with the broker's own key. The tenant
-- comes only from the customer mapping; both keys are null for an unattributed event. The
-- object is the closed normalised shape of packages/work/src/billing/stripe-objects.ts:
-- ids, amounts, statuses and times only.
CREATE TABLE morrow_billing.stripe_event_receipts (
 organization_id morrow_work.record_id,
 workspace_id morrow_work.record_id,
 id morrow_work.record_id NOT NULL PRIMARY KEY CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 event_id text NOT NULL UNIQUE CHECK (event_id ~ '^evt_[A-Za-z0-9_]{8,250}$'),
 event_type text NOT NULL CHECK (event_type IN ('checkout.session.completed','checkout.session.expired','invoice.paid',
  'invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted')),
 livemode boolean NOT NULL,
 mode text NOT NULL,
 object_type text NOT NULL CHECK (object_type IN ('invoice','subscription','checkout_session')),
 object_id text NOT NULL CHECK (object_id ~ '^(in_[A-Za-z0-9]{8,100}|sub_[A-Za-z0-9]{8,100}|cs_[A-Za-z0-9_]{8,250})$'),
 customer_id text CHECK (customer_id ~ '^cus_[A-Za-z0-9]{8,100}$'),
 object jsonb NOT NULL CHECK (jsonb_typeof(object)='object' AND pg_column_size(object)<=8192
  AND object->>'kind'=object_type AND object->>'id'=object_id AND object->'livemode'=to_jsonb(livemode)),
 object_digest morrow_work.digest NOT NULL,
 observed_at timestamptz NOT NULL CHECK (observed_at=date_trunc('milliseconds',observed_at) AND observed_at>=timestamptz '2000-01-01T00:00:00Z' AND observed_at<timestamptz '9000-01-01T00:00:00Z'),
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=timestamptz '2000-01-01T00:00:00Z' AND recorded_at<timestamptz '9000-01-01T00:00:00Z'),
 UNIQUE (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT stripe_event_receipts_tenant CHECK ((organization_id IS NULL)=(workspace_id IS NULL)),
 CONSTRAINT stripe_event_receipts_mode CHECK (mode=CASE WHEN livemode THEN 'live' ELSE 'test' END),
 CONSTRAINT stripe_event_receipts_object CHECK (CASE object_type
  WHEN 'invoice' THEN event_type IN ('invoice.paid','invoice.payment_failed')
  WHEN 'subscription' THEN event_type IN ('customer.subscription.updated','customer.subscription.deleted')
  ELSE event_type IN ('checkout.session.completed','checkout.session.expired') END)
);

-- The one application of a receipt by the ingress (receipt_apply): its outcome and code.
-- Written once, never changed; the receipt itself stays as the broker recorded it.
CREATE TABLE morrow_billing.receipt_applications (
 organization_id morrow_work.record_id,
 workspace_id morrow_work.record_id,
 receipt_id morrow_work.record_id NOT NULL PRIMARY KEY REFERENCES morrow_billing.stripe_event_receipts(id),
 outcome text NOT NULL CHECK (outcome IN ('applied','held','conflict','no_charge','refused','already_granted','ignored')),
 outcome_code text CHECK (outcome_code ~ '^[A-Z][A-Z_]{2,63}$'),
 applied_at timestamptz NOT NULL CHECK (applied_at=date_trunc('milliseconds',applied_at) AND applied_at>=timestamptz '2000-01-01T00:00:00Z' AND applied_at<timestamptz '9000-01-01T00:00:00Z'),
 UNIQUE (organization_id,workspace_id,receipt_id),
 FOREIGN KEY (organization_id,workspace_id,receipt_id) REFERENCES morrow_billing.stripe_event_receipts(organization_id,workspace_id,id),
 CONSTRAINT receipt_applications_tenant CHECK ((organization_id IS NULL)=(workspace_id IS NULL))
);

-- The entry proof of the receipt context (the 0020 lease_entries idiom): one row per
-- backend, written only by receipt_begin for the receipt it admitted, in this transaction,
-- with a fresh nonce it also places in the setting. The api login can set any setting but
-- reaches this table only through receipt_begin, so a forged context matches no row.
CREATE TABLE morrow_billing.receipt_entries (
 backend_pid integer NOT NULL PRIMARY KEY CHECK (backend_pid>0),
 xact_id text NOT NULL CHECK (xact_id ~ '^(0|[1-9][0-9]{0,19})$'),
 receipt_id text NOT NULL CHECK (receipt_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 receipt_organization_id text,
 receipt_workspace_id text,
 nonce text NOT NULL CHECK (nonce ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 CONSTRAINT receipt_entries_tenant CHECK ((receipt_organization_id IS NULL)=(receipt_workspace_id IS NULL))
);

-- BillingAccount@2, Morrow-direct only (the Shopify route lands with P18.T01b): the
-- workspace's one storeless account, created in the transaction that fixes its route.
CREATE TABLE morrow_billing.billing_accounts (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 route text NOT NULL CHECK (route='morrow_direct'),
 mode text NOT NULL CHECK (mode IN ('live','test')),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 status text NOT NULL CHECK (status IN ('pending','active','suspended','cancelled')),
 revision morrow_work.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT billing_accounts_times CHECK (updated_at>=created_at)
);
CREATE UNIQUE INDEX billing_accounts_one_direct ON morrow_billing.billing_accounts (organization_id,workspace_id) WHERE route='morrow_direct';

-- EntitlementSnapshot@2: one row per fold of a provider read, revisions contiguous per
-- account, append-only. The evidence reference is the receipt's object digest.
CREATE TABLE morrow_billing.entitlement_snapshots (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 billing_account_id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 route text NOT NULL CHECK (route='morrow_direct'),
 mode text NOT NULL CHECK (mode IN ('live','test')),
 subscription_key text NOT NULL CHECK (subscription_key ~ '^stripe:sub:sub_[A-Za-z0-9]{8,100}$'),
 status text NOT NULL CHECK (status IN ('active','pending','past_due','suspended','cancelled')),
 provider_evidence_ref morrow_work.digest NOT NULL,
 verified_at timestamptz NOT NULL CHECK (verified_at=date_trunc('milliseconds',verified_at) AND isfinite(verified_at)),
 valid_until timestamptz NOT NULL CHECK (valid_until=date_trunc('milliseconds',valid_until) AND isfinite(valid_until)),
 receipt_id morrow_work.record_id NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=timestamptz '2000-01-01T00:00:00Z' AND recorded_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,billing_account_id,revision),
 FOREIGN KEY (organization_id,workspace_id,billing_account_id) REFERENCES morrow_billing.billing_accounts(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,receipt_id) REFERENCES morrow_billing.stripe_event_receipts(organization_id,workspace_id,id)
);

-- VerifiedPaymentEvent@1 for attributed Stripe subscription-period invoices, with the
-- classification outcome (held, unattributed and terms-mismatched events without a
-- derivable period are recorded only on receipt_applications). Unique per route, mode and
-- payment key; append-only (held-payment re-classification is M6).
CREATE TABLE morrow_billing.verified_payment_events (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 route text NOT NULL CHECK (route='morrow_direct'),
 mode text NOT NULL CHECK (mode IN ('live','test')),
 payment_key text NOT NULL CHECK (payment_key ~ '^stripe:invoice:in_[A-Za-z0-9]{8,100}$'),
 kind text NOT NULL CHECK (kind='subscription_period'),
 subscription_key text NOT NULL CHECK (subscription_key ~ '^stripe:sub:sub_[A-Za-z0-9]{8,100}$'),
 price_key text NOT NULL CHECK (price_key ~ '^stripe:price:price_[A-Za-z0-9]{8,100}$'),
 period_start timestamptz NOT NULL CHECK (period_start=date_trunc('milliseconds',period_start) AND isfinite(period_start)),
 period_end timestamptz NOT NULL CHECK (period_end=date_trunc('milliseconds',period_end) AND isfinite(period_end)),
 operation_id morrow_work.record_id,
 amount text NOT NULL CHECK (amount ~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,9})?$'),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 provider_evidence_ref morrow_work.digest NOT NULL,
 verified_at timestamptz NOT NULL CHECK (verified_at=date_trunc('milliseconds',verified_at) AND isfinite(verified_at)),
 outcome text NOT NULL CHECK (outcome IN ('granted','held','no_charge','conflict')),
 outcome_code text CHECK (outcome_code IN ('NOT_MORROW_INITIATED','TERMS_MISMATCH','SUBSCRIPTION_NOT_CURRENT','ROUTE_MISMATCH',
  'DUPLICATE_SUBSCRIPTION','SUBSCRIPTION_TERMINAL','SUBSCRIPTION_REQUIRED')),
 receipt_id morrow_work.record_id NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=timestamptz '2000-01-01T00:00:00Z' AND recorded_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (route,mode,payment_key),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,receipt_id) REFERENCES morrow_billing.stripe_event_receipts(organization_id,workspace_id,id),
 CONSTRAINT verified_payment_events_period CHECK (period_end>period_start),
 CONSTRAINT verified_payment_events_outcome CHECK ((outcome IN ('granted','no_charge'))=(outcome_code IS NULL)
  AND (outcome<>'held' OR outcome_code IN ('NOT_MORROW_INITIATED','TERMS_MISMATCH','SUBSCRIPTION_NOT_CURRENT'))
  AND (outcome<>'conflict' OR outcome_code IN ('ROUTE_MISMATCH','DUPLICATE_SUBSCRIPTION','SUBSCRIPTION_TERMINAL','SUBSCRIPTION_REQUIRED'))
  AND (outcome<>'granted' OR operation_id IS NOT NULL))
);

-- CreditGrant@2: credits from Morrow's terms for one verified payment, once per route,
-- mode and payment key, funding exactly one wallet revision. Unused credits roll over in
-- the beta (ADR-0022 item 11 amendment, 2026-10-20): expires_at is always null.
CREATE TABLE morrow_billing.credit_grants (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 billing_account_id morrow_work.record_id NOT NULL,
 route text NOT NULL CHECK (route='morrow_direct'),
 mode text NOT NULL CHECK (mode IN ('live','test')),
 payment_key text NOT NULL CHECK (payment_key ~ '^stripe:invoice:in_[A-Za-z0-9]{8,100}$'),
 kind text NOT NULL CHECK (kind IN ('included','purchased')),
 credit_units bigint NOT NULL CHECK (credit_units BETWEEN 1 AND 999999999999999999),
 terms_revision morrow_work.revision NOT NULL REFERENCES morrow_billing.billing_terms(terms_revision),
 purchase_evidence_ref morrow_work.digest NOT NULL,
 effective_at timestamptz NOT NULL CHECK (effective_at=date_trunc('milliseconds',effective_at) AND isfinite(effective_at)),
 expires_at timestamptz CHECK (expires_at IS NULL),
 funded_wallet_revision morrow_work.revision NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=timestamptz '2000-01-01T00:00:00Z' AND recorded_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (route,mode,payment_key),
 UNIQUE (organization_id,workspace_id,billing_account_id,funded_wallet_revision),
 FOREIGN KEY (organization_id,workspace_id,billing_account_id) REFERENCES morrow_billing.billing_accounts(organization_id,workspace_id,id),
 FOREIGN KEY (route,mode,payment_key) REFERENCES morrow_billing.verified_payment_events(route,mode,payment_key)
);

-- CreditWallet@1 per billing account (integration: keyed by billing_account_id, created
-- when the route is fixed). wallet_guard admits a grant-funded increase of available or a
-- move that keeps available+reserved+consumed (M3 PR-1's reserve, settle and release).
CREATE TABLE morrow_billing.credit_wallets (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 billing_account_id morrow_work.record_id NOT NULL,
 available bigint NOT NULL CHECK (available>=0),
 reserved bigint NOT NULL CHECK (reserved>=0),
 consumed bigint NOT NULL CHECK (consumed>=0),
 rate_revision morrow_work.revision NOT NULL,
 terms_revision morrow_work.revision NOT NULL REFERENCES morrow_billing.billing_terms(terms_revision),
 revision morrow_work.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,billing_account_id),
 FOREIGN KEY (organization_id,workspace_id,billing_account_id) REFERENCES morrow_billing.billing_accounts(organization_id,workspace_id,id),
 CONSTRAINT credit_wallets_times CHECK (updated_at>=created_at)
);

-- ---------------------------------------------------------------------------
-- Row security. Every table: ENABLE + FORCE and the maintenance-only owner policy.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['billing_terms','stripe_customers','checkout_intents','stripe_operations','stripe_event_receipts','receipt_applications',
  'receipt_entries','billing_accounts','entitlement_snapshots','verified_payment_events','credit_grants','credit_wallets'] LOOP
  EXECUTE format('ALTER TABLE morrow_billing.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_billing.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_billing.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_billing.%I FROM PUBLIC',t);
 END LOOP;
END $$;

-- The receipt context. receipt_ingress: the api login with no work session context (the
-- ingress definers refuse everything else). receipt_entered and receipt_tenant: that, plus
-- this backend's entry proof for this transaction and nonce, naming the receipt or its
-- tenant. INVOKER, owned by the owner, EXECUTE for the command role (the policies'
-- evaluator inside definers); nobody else.
CREATE FUNCTION morrow_billing.receipt_ingress() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT session_user='morrow_api_worker'
  AND COALESCE(pg_catalog.current_setting('morrow.work_session_digest',true),'')=''
  AND COALESCE(pg_catalog.current_setting('morrow.work_workspace',true),'')=''
  AND COALESCE(pg_catalog.current_setting('morrow.work_lease_id',true),'')=''
$$;
CREATE FUNCTION morrow_billing.receipt_entered(p_receipt text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT morrow_billing.receipt_ingress() AND EXISTS(SELECT 1 FROM morrow_billing.receipt_entries e
  WHERE e.backend_pid=pg_catalog.pg_backend_pid() AND e.xact_id=pg_catalog.pg_current_xact_id_if_assigned()::text
   AND e.nonce=pg_catalog.current_setting('morrow.billing_receipt_entered',true) AND e.receipt_id=p_receipt)
$$;
CREATE FUNCTION morrow_billing.receipt_tenant(p_org text,p_ws text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT morrow_billing.receipt_ingress() AND EXISTS(SELECT 1 FROM morrow_billing.receipt_entries e
  WHERE e.backend_pid=pg_catalog.pg_backend_pid() AND e.xact_id=pg_catalog.pg_current_xact_id_if_assigned()::text
   AND e.nonce=pg_catalog.current_setting('morrow.billing_receipt_entered',true)
   AND e.receipt_organization_id=p_org AND e.receipt_workspace_id=p_ws)
$$;

-- Policies. tenant_command and tenant_read are the P06.T01a template (session context).
-- broker_billing: the broker's login, through its own definers only (the vault_broker
-- idiom of 0020). receipt_apply: the receipt context of the receipt's own tenant.
-- platform_command_read and platform_api_read: the terms table, readable by both roles.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['stripe_customers','checkout_intents','stripe_operations','billing_accounts','entitlement_snapshots',
  'verified_payment_events','credit_grants','credit_wallets'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_billing.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['checkout_intents','billing_accounts','entitlement_snapshots','verified_payment_events','credit_grants','credit_wallets'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_billing.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['stripe_customers','checkout_intents','stripe_operations','stripe_event_receipts'] LOOP
  EXECUTE format('CREATE POLICY broker_billing ON morrow_billing.%I TO morrow_work_command
   USING (session_user=''morrow_vault_broker'') WITH CHECK (session_user=''morrow_vault_broker'')',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['workspace_billing_routes','checkout_intents','stripe_operations','billing_accounts','entitlement_snapshots',
  'verified_payment_events','credit_grants','credit_wallets'] LOOP
  EXECUTE format('CREATE POLICY receipt_apply ON morrow_billing.%I TO morrow_work_command
   USING (morrow_billing.receipt_tenant(organization_id::text,workspace_id::text))
   WITH CHECK (morrow_billing.receipt_tenant(organization_id::text,workspace_id::text))',t);
 END LOOP;
END $$;
CREATE POLICY platform_command_read ON morrow_billing.billing_terms FOR SELECT TO morrow_work_command USING (true);
CREATE POLICY platform_api_read ON morrow_billing.billing_terms FOR SELECT TO morrow_work_api USING (true);
CREATE POLICY receipt_ingress_read ON morrow_billing.stripe_event_receipts FOR SELECT TO morrow_work_command
 USING (morrow_billing.receipt_ingress());
CREATE POLICY receipt_ingress_read ON morrow_billing.receipt_applications FOR SELECT TO morrow_work_command
 USING (morrow_billing.receipt_ingress());
CREATE POLICY receipt_ingress_apply ON morrow_billing.receipt_applications FOR INSERT TO morrow_work_command
 WITH CHECK (morrow_billing.receipt_entered(receipt_id::text));
CREATE POLICY receipt_entry ON morrow_billing.receipt_entries TO morrow_work_command
 USING (session_user='morrow_api_worker' AND backend_pid=pg_catalog.pg_backend_pid())
 WITH CHECK (session_user='morrow_api_worker' AND backend_pid=pg_catalog.pg_backend_pid());
-- The broker's own Stripe operations on the M2 tables (0020): only kind stripe_write.
CREATE POLICY broker_stripe ON morrow_work.operations TO morrow_work_command
 USING (session_user='morrow_vault_broker' AND kind='stripe_write')
 WITH CHECK (session_user='morrow_vault_broker' AND kind='stripe_write');
CREATE POLICY broker_stripe_transition ON morrow_work.operation_transitions TO morrow_work_command
 USING (session_user='morrow_vault_broker' AND EXISTS(SELECT 1 FROM morrow_work.operations o WHERE o.organization_id=operation_transitions.organization_id
  AND o.workspace_id=operation_transitions.workspace_id AND o.id=operation_transitions.operation_id AND o.kind='stripe_write'))
 WITH CHECK (session_user='morrow_vault_broker' AND EXISTS(SELECT 1 FROM morrow_work.operations o WHERE o.organization_id=operation_transitions.organization_id
  AND o.workspace_id=operation_transitions.workspace_id AND o.id=operation_transitions.operation_id AND o.kind='stripe_write'));

-- Runtime privileges: table SELECT and INSERT, column-scoped UPDATE, never DELETE or
-- TRUNCATE. The api role reads the tenant-readable tables column by column.
GRANT SELECT ON morrow_billing.billing_terms TO morrow_work_command;
GRANT SELECT,INSERT ON morrow_billing.stripe_customers,morrow_billing.checkout_intents,morrow_billing.stripe_operations,
 morrow_billing.stripe_event_receipts,morrow_billing.receipt_applications,morrow_billing.receipt_entries,morrow_billing.billing_accounts,
 morrow_billing.entitlement_snapshots,morrow_billing.verified_payment_events,morrow_billing.credit_grants,morrow_billing.credit_wallets TO morrow_work_command;
GRANT UPDATE (status,revision,stripe_session_id,updated_at) ON morrow_billing.checkout_intents TO morrow_work_command;
GRANT UPDATE (provider_object_id) ON morrow_billing.stripe_operations TO morrow_work_command;
GRANT UPDATE (xact_id,receipt_id,receipt_organization_id,receipt_workspace_id,nonce) ON morrow_billing.receipt_entries TO morrow_work_command;
GRANT UPDATE (status,revision,updated_at) ON morrow_billing.billing_accounts TO morrow_work_command;
GRANT UPDATE (available,reserved,consumed,revision,updated_at) ON morrow_billing.credit_wallets TO morrow_work_command;
GRANT UPDATE (route,mode,route_fixed_at,fixing_payment_key,revision,updated_at) ON morrow_billing.workspace_billing_routes TO morrow_work_command;
GRANT SELECT (terms_revision,terms,offers,digest,recorded_at) ON morrow_billing.billing_terms TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,revision,status,price_key,terms_revision,route_revision,mode,actor_principal_id,actor_membership_id,
 customer_operation_id,checkout_operation_id,expires_at,created_at,updated_at) ON morrow_billing.checkout_intents TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at) ON morrow_billing.billing_accounts TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,billing_account_id,revision,route,mode,subscription_key,status,provider_evidence_ref,verified_at,valid_until,
 recorded_at) ON morrow_billing.entitlement_snapshots TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,route,mode,payment_key,kind,subscription_key,price_key,period_start,period_end,operation_id,amount,currency,
 provider_evidence_ref,verified_at,outcome,outcome_code,recorded_at) ON morrow_billing.verified_payment_events TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,billing_account_id,route,mode,payment_key,kind,credit_units,terms_revision,purchase_evidence_ref,
 effective_at,expires_at,funded_wallet_revision,recorded_at) ON morrow_billing.credit_grants TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,terms_revision,revision,created_at,updated_at)
 ON morrow_billing.credit_wallets TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody. They run with the writer's
-- privileges under its policies and raise a fixed code.
-- Terms: born at the next contiguous revision with well-formed entries and an offer per
-- priced subscription entry; never changed.
CREATE FUNCTION morrow_billing.terms_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_previous bigint; e jsonb; f jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BILLING_TERMS_IMMUTABLE'; END IF;
 SELECT max(t.terms_revision) INTO v_previous FROM morrow_billing.billing_terms t;
 IF NEW.terms_revision<>COALESCE(v_previous,0)+1 OR NEW.recorded_at IS NULL THEN RAISE EXCEPTION 'BILLING_TERMS_INVALID'; END IF;
 FOR e IN SELECT x FROM jsonb_array_elements(NEW.terms->'entries') x LOOP
  IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(e) k)
    IS DISTINCT FROM ARRAY['creditUnits','currency','kind','mode','priceKey','route']
   OR e->>'route' NOT IN ('morrow_direct','shopify_app_pricing') OR e->>'mode' NOT IN ('live','test')
   OR e->>'kind' NOT IN ('subscription_period','top_up') OR e->>'currency' !~ '^[A-Z]{3}$'
   OR jsonb_typeof(e->'creditUnits')<>'string' OR e->>'creditUnits' !~ '^(0|[1-9][0-9]{0,17})$'
   OR (e->>'route'='morrow_direct' AND e->>'priceKey' !~ '^stripe:price:price_[A-Za-z0-9]{8,100}$') THEN
   RAISE EXCEPTION 'BILLING_TERMS_INVALID';
  END IF;
 END LOOP;
 FOR f IN SELECT x FROM jsonb_array_elements(NEW.offers) x LOOP
  IF jsonb_typeof(f)<>'object' OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(f) k)
    IS DISTINCT FROM ARRAY['currency','interval','priceKey','unitAmount']
   OR f->>'interval'<>'month' OR f->>'currency' !~ '^[A-Z]{3}$' OR jsonb_typeof(f->'unitAmount')<>'string'
   OR f->>'unitAmount' !~ '^[1-9][0-9]{0,8}$'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.terms->'entries') x WHERE x->>'route'='morrow_direct'
    AND x->>'kind'='subscription_period' AND x->>'priceKey'=f->>'priceKey' AND x->>'currency'=f->>'currency') THEN
   RAISE EXCEPTION 'BILLING_TERMS_INVALID';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
-- Intents: born open at revision 1 without a session; each update is revision+1 along
-- open -> completed | verified | expired | failed and completed -> verified | failed; the
-- session id is set once, while open; nothing else changes.
CREATE FUNCTION morrow_billing.intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','revision','stripe_session_id','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'open' OR NEW.stripe_session_id IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'BILLING_INTENT_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR (NEW.stripe_session_id IS DISTINCT FROM OLD.stripe_session_id AND (OLD.stripe_session_id IS NOT NULL OR OLD.status<>'open'))
  OR (NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status='open' AND NEW.status IN ('completed','verified','expired','failed'))
   OR (OLD.status='completed' AND NEW.status IN ('verified','failed'))))
  OR (NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.stripe_session_id IS NOT DISTINCT FROM OLD.stripe_session_id) THEN
  RAISE EXCEPTION 'BILLING_INTENT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- A Stripe operation's provider object id is set once; nothing else changes.
CREATE FUNCTION morrow_billing.stripe_operation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.provider_object_id IS NOT NULL THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.provider_object_id IS NOT NULL OR NEW.provider_object_id IS NULL
  OR (to_jsonb(NEW)-'provider_object_id') IS DISTINCT FROM (to_jsonb(OLD)-'provider_object_id') THEN
  RAISE EXCEPTION 'BILLING_OPERATION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Accounts: born at revision 1; each update is revision+1 and changes only the status.
CREATE FUNCTION morrow_billing.account_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','revision','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'BILLING_ACCOUNT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'BILLING_ACCOUNT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Snapshots: the next contiguous revision of the account, of its route and mode; a
-- cancelled subscription is absorbing (no later live snapshot of it).
CREATE FUNCTION morrow_billing.snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE a record; p record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BILLING_SNAPSHOT_IMMUTABLE'; END IF;
 SELECT x.route,x.mode INTO a FROM morrow_billing.billing_accounts x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.billing_account_id;
 SELECT x.revision::bigint AS revision,x.subscription_key,x.status INTO p FROM morrow_billing.entitlement_snapshots x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.billing_account_id=NEW.billing_account_id
  ORDER BY x.revision DESC LIMIT 1;
 IF a.route IS DISTINCT FROM NEW.route OR a.mode IS DISTINCT FROM NEW.mode
  OR NEW.revision<>COALESCE(p.revision,0)+1
  OR (p.status='cancelled' AND p.subscription_key=NEW.subscription_key AND NEW.status<>'cancelled') THEN
  RAISE EXCEPTION 'BILLING_SNAPSHOT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Wallets: born empty at revision 1. Each update is revision+1 and either (a) raises
-- available by exactly the units of the credit grant that funds this revision (inserted
-- first, in the same transaction), with reserved and consumed unchanged, or (b) moves
-- credits between available, reserved and consumed, keeping their sum and never lowering
-- consumed. Replaceable by a forward migration; M3 PR-1's moves need no change.
CREATE FUNCTION morrow_billing.wallet_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['available','reserved','consumed','revision','updated_at']; v_delta numeric;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.available<>0 OR NEW.reserved<>0 OR NEW.consumed<>0 OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'BILLING_WALLET_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) OR NEW.consumed<OLD.consumed THEN
  RAISE EXCEPTION 'BILLING_WALLET_INVALID';
 END IF;
 v_delta:=(NEW.available::numeric+NEW.reserved+NEW.consumed)-(OLD.available::numeric+OLD.reserved+OLD.consumed);
 IF v_delta=0 THEN RETURN NEW; END IF;
 IF v_delta>0 AND NEW.reserved=OLD.reserved AND NEW.consumed=OLD.consumed
  AND EXISTS(SELECT 1 FROM morrow_billing.credit_grants g WHERE g.organization_id=NEW.organization_id AND g.workspace_id=NEW.workspace_id
   AND g.billing_account_id=NEW.billing_account_id AND g.funded_wallet_revision=NEW.revision AND g.credit_units=v_delta) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'BILLING_WALLET_INVALID';
END $$;
-- A grant funds the wallet revision after the current one (or the first funded revision,
-- 2, when the wallet is created in the same transaction) and names a granted payment.
CREATE FUNCTION morrow_billing.grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE w record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BILLING_GRANT_IMMUTABLE'; END IF;
 SELECT x.revision::bigint AS revision INTO w FROM morrow_billing.credit_wallets x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.billing_account_id=NEW.billing_account_id;
 IF NOT FOUND OR NEW.funded_wallet_revision<>w.revision+1
  OR NOT EXISTS(SELECT 1 FROM morrow_billing.verified_payment_events v WHERE v.route=NEW.route AND v.mode=NEW.mode
   AND v.payment_key=NEW.payment_key AND v.organization_id=NEW.organization_id AND v.workspace_id=NEW.workspace_id AND v.outcome='granted') THEN
  RAISE EXCEPTION 'BILLING_GRANT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- An application names its receipt's own tenant.
CREATE FUNCTION morrow_billing.application_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BILLING_RECEIPT_IMMUTABLE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_billing.stripe_event_receipts r WHERE r.id=NEW.receipt_id
   AND r.organization_id IS NOT DISTINCT FROM NEW.organization_id AND r.workspace_id IS NOT DISTINCT FROM NEW.workspace_id) THEN
  RAISE EXCEPTION 'BILLING_RECEIPT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- The application fixes a route only in a receipt context of its own tenant
-- (receipt_apply): no session, lease or broker definer of the command role can fix it.
-- Owner maintenance (the owner's scripts and lab fixtures) is not the application and is
-- unaffected. route_guard (0020) still decides fix-once.
CREATE FUNCTION morrow_billing.route_fix_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
BEGIN
 IF OLD.route IS NULL AND NEW.route IS NOT NULL AND current_user='morrow_work_command'
  AND NOT morrow_billing.receipt_tenant(NEW.organization_id::text,NEW.workspace_id::text) THEN
  RAISE EXCEPTION 'BILLING_ROUTE_FIX_DENIED';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['terms_guard()','intent_guard()','stripe_operation_guard()','account_guard()','snapshot_guard()','wallet_guard()',
  'grant_guard()','application_guard()','route_fix_guard()','receipt_ingress()','receipt_entered(text)','receipt_tenant(text,text)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION morrow_billing.%s FROM PUBLIC',f);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION morrow_billing.receipt_ingress(),morrow_billing.receipt_entered(text),morrow_billing.receipt_tenant(text,text)
 TO morrow_work_command;
CREATE TRIGGER terms_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_billing.billing_terms FOR EACH ROW EXECUTE FUNCTION morrow_billing.terms_guard();
CREATE TRIGGER intent_guard BEFORE INSERT OR UPDATE ON morrow_billing.checkout_intents FOR EACH ROW EXECUTE FUNCTION morrow_billing.intent_guard();
CREATE TRIGGER stripe_operation_guard BEFORE INSERT OR UPDATE ON morrow_billing.stripe_operations FOR EACH ROW EXECUTE FUNCTION morrow_billing.stripe_operation_guard();
CREATE TRIGGER account_guard BEFORE INSERT OR UPDATE ON morrow_billing.billing_accounts FOR EACH ROW EXECUTE FUNCTION morrow_billing.account_guard();
CREATE TRIGGER snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_billing.entitlement_snapshots FOR EACH ROW EXECUTE FUNCTION morrow_billing.snapshot_guard();
CREATE TRIGGER wallet_guard BEFORE INSERT OR UPDATE ON morrow_billing.credit_wallets FOR EACH ROW EXECUTE FUNCTION morrow_billing.wallet_guard();
CREATE TRIGGER grant_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_billing.credit_grants FOR EACH ROW EXECUTE FUNCTION morrow_billing.grant_guard();
CREATE TRIGGER application_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_billing.receipt_applications FOR EACH ROW EXECUTE FUNCTION morrow_billing.application_guard();
CREATE TRIGGER route_fix_guard BEFORE UPDATE ON morrow_billing.workspace_billing_routes FOR EACH ROW EXECUTE FUNCTION morrow_billing.route_fix_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['stripe_customers','stripe_event_receipts','verified_payment_events'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_billing.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['checkout_intents','stripe_operations','billing_accounts','credit_wallets'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE DELETE ON morrow_billing.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['billing_terms','stripe_customers','checkout_intents','stripe_operations','stripe_event_receipts','receipt_applications',
  'billing_accounts','entitlement_snapshots','verified_payment_events','credit_grants','credit_wallets'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_billing.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- API session definers: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_work_api only. No tenant, workspace or actor parameter: both come
-- from current_tenant(). Each refuses inside a receipt context.
-- The workspace's store associations through the identity bridge (ids and states only).
CREATE FUNCTION morrow_billing.workspace_associations()
RETURNS TABLE(installation_id text,store_id text,connection_id text,status text,linked_at text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 IF COALESCE(pg_catalog.current_setting('morrow.billing_receipt_entered',true),'')<>'' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT a.installation_id,a.store_id,a.connection_id,a.status,morrow_work.utc_text(date_trunc('milliseconds',a.linked_at))
  FROM morrow_identity.work_store_installations(t.organization_id,t.workspace_id) a;
END $$;

-- Opens one Morrow checkout (P18.T01a; ADR-0022 item 12): replay by the actor's key, the
-- locked freshness recheck, then under the route row's lock the route must still be
-- unfixed, website, never bound and without any association, the terms revision current
-- and the price a morrow_direct subscription entry. Lazily expires open intents past
-- expires_at plus five minutes, reuses the workspace's open intent for the same price (a
-- later terms revision credits it at payment time, R10), and
-- otherwise records the intent with its customer operation (unless mapped, or one is
-- already in flight) and its checkout operation, both planned -> authorized. Outcomes:
-- applied, replayed, reused, invalid, ineligible, command_conflict, stale_authority,
-- route_conflict, terms_conflict, checkout_conflict.
CREATE FUNCTION morrow_billing.cmd_checkout_open(p_key text,p_request_digest text,p_correlation_id text,p_price_key text,
 p_terms_revision text,p_route_revision text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE
 t record; i record; r record; o record; v_check text; v_terms record; v_entry jsonb; v_count integer; v_mode text;
 v_at timestamptz; v_expires timestamptz; v_intent text; v_checkout text; v_customer_op text; v_new_customer boolean:=false; v_mapped boolean;
BEGIN
 IF p_key IS NULL OR p_key !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_request_digest IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$'
  OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_price_key IS NULL OR p_price_key !~ '^stripe:price:price_[A-Za-z0-9]{8,100}$'
  OR p_terms_revision IS NULL OR p_terms_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_route_revision IS NULL OR p_route_revision !~ '^[1-9][0-9]{0,15}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF COALESCE(pg_catalog.current_setting('morrow.billing_receipt_entered',true),'')<>'' THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text; RETURN;
 END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND OR t.principal_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_principal_id',true)
  OR t.membership_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_membership_id',true) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text; RETURN;
 END IF;
 -- Replay first: the per-actor key lock (shared with the portal command), then the record.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.billing.command',t.organization_id,t.workspace_id,t.principal_id,p_key)::text,0));
 IF EXISTS(SELECT 1 FROM morrow_billing.stripe_operations s WHERE s.organization_id=t.organization_id AND s.workspace_id=t.workspace_id
   AND s.actor_principal_id=t.principal_id AND s.idempotency_key=p_key) THEN
  RETURN QUERY SELECT 'command_conflict'::text,NULL::text; RETURN;
 END IF;
 SELECT x.* INTO i FROM morrow_billing.checkout_intents x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
  AND x.actor_principal_id=t.principal_id AND x.idempotency_key=p_key;
 IF FOUND THEN
  IF i.request_digest::text<>p_request_digest THEN RETURN QUERY SELECT 'command_conflict'::text,NULL::text; RETURN; END IF;
  RETURN QUERY SELECT 'replayed'::text,jsonb_build_object('intentId',i.id::text,'status',i.status,'customerOperationId',i.customer_operation_id::text,
   'checkoutOperationId',i.checkout_operation_id::text,'expiresAt',morrow_work.utc_text(i.expires_at))::text;
  RETURN;
 END IF;
 v_check:=morrow_identity.work_lock_and_recheck(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true),
  pg_catalog.current_setting('morrow.work_principal_id',true),pg_catalog.current_setting('morrow.work_membership_id',true),
  pg_catalog.current_setting('morrow.work_policy_revision',true),pg_catalog.current_setting('morrow.work_grants_digest',true),
  pg_catalog.current_setting('morrow.work_evaluated_at_us',true));
 IF v_check='ineligible' THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text; RETURN;
 ELSIF v_check IS DISTINCT FROM 'current' THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 -- The route row lock serialises this workspace's checkouts and receipt applications.
 SELECT x.origin,x.shopify_bound_at,x.route,x.revision::bigint AS revision INTO r FROM morrow_billing.workspace_billing_routes x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id FOR UPDATE;
 IF NOT FOUND OR r.route IS NOT NULL OR r.origin<>'website' OR r.shopify_bound_at IS NOT NULL OR r.revision::text<>p_route_revision
  OR EXISTS(SELECT 1 FROM morrow_identity.work_store_installations(t.organization_id,t.workspace_id)) THEN
  RETURN QUERY SELECT 'route_conflict'::text,NULL::text; RETURN;
 END IF;
 SELECT x.terms_revision::bigint AS terms_revision,x.terms INTO v_terms FROM morrow_billing.billing_terms x ORDER BY x.terms_revision DESC LIMIT 1;
 IF NOT FOUND OR v_terms.terms_revision::text<>p_terms_revision THEN
  RETURN QUERY SELECT 'terms_conflict'::text,NULL::text; RETURN;
 END IF;
 SELECT count(*)::integer,(array_agg(e))[1] INTO v_count,v_entry FROM jsonb_array_elements(v_terms.terms->'entries') e
  WHERE e->>'route'='morrow_direct' AND e->>'priceKey'=p_price_key AND e->>'kind'='subscription_period';
 IF v_count<>1 THEN RETURN QUERY SELECT 'terms_conflict'::text,NULL::text; RETURN; END IF;
 v_mode:=v_entry->>'mode';
 v_at:=morrow_work.db_now();
 -- The lazy close: an open intent past its Stripe expiry plus a margin is expired.
 UPDATE morrow_billing.checkout_intents x SET status='expired',revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.status='open' AND x.expires_at+interval '5 minutes'<=v_at;
 SELECT x.* INTO i FROM morrow_billing.checkout_intents x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
  AND x.status IN ('open','completed');
 IF FOUND THEN
  IF i.status='open' AND i.price_key=p_price_key THEN
   RETURN QUERY SELECT 'reused'::text,jsonb_build_object('intentId',i.id::text,'status',i.status,'customerOperationId',i.customer_operation_id::text,
    'checkoutOperationId',i.checkout_operation_id::text,'expiresAt',morrow_work.utc_text(i.expires_at))::text;
   RETURN;
  END IF;
  RETURN QUERY SELECT 'checkout_conflict'::text,NULL::text; RETURN;
 END IF;
 v_mapped:=EXISTS(SELECT 1 FROM morrow_billing.stripe_customers x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id);
 IF NOT v_mapped THEN
  -- One customer per workspace: an earlier customer operation that has not failed is
  -- reused (its idempotency key is bound to it), never a second one.
  SELECT s.operation_id::text INTO v_customer_op FROM morrow_billing.stripe_operations s JOIN morrow_work.operations o2
   ON o2.organization_id=s.organization_id AND o2.workspace_id=s.workspace_id AND o2.id=s.operation_id
   WHERE s.organization_id=t.organization_id AND s.workspace_id=t.workspace_id AND s.purpose='customer_create'
    AND o2.status NOT IN ('failed','cancelled','rejected','conflict')
   ORDER BY o2.created_at DESC,s.operation_id::text COLLATE "C" LIMIT 1;
  IF NOT FOUND THEN v_customer_op:=gen_random_uuid()::text; v_new_customer:=true; END IF;
 END IF;
 v_intent:=gen_random_uuid()::text; v_checkout:=gen_random_uuid()::text;
 v_expires:=date_trunc('second',v_at)+interval '1 hour';
 IF v_new_customer THEN
  INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,task_id,store_id,connection_id,target_index,
   target_resource_id,proposal_id,proposal_digest,approval_id,approval_revision,approval_digest,claim_family_root_id,lease_id,status,
   request_digest,attempt,send_started_at,submitted_at,provider_request_id,uncertainty_reason,created_at,updated_at)
  VALUES (t.organization_id,t.workspace_id,v_customer_op,1,'stripe_write','governance.billing.manage',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
   NULL,NULL,NULL,'planned',morrow_work.sha256_text(array_to_json(ARRAY['morrow.billing.stripe_request','1','customer_create',v_customer_op,
    t.organization_id,t.workspace_id])::text),0,NULL,NULL,NULL,NULL,v_at,v_at);
  SELECT * INTO o FROM morrow_work.operation_transition(t.organization_id,t.workspace_id,v_customer_op,1,'authorized','action_service',
   'current_grants_and_preconditions',NULL,NULL,NULL);
  IF o.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
 END IF;
 INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,task_id,store_id,connection_id,target_index,
  target_resource_id,proposal_id,proposal_digest,approval_id,approval_revision,approval_digest,claim_family_root_id,lease_id,status,
  request_digest,attempt,send_started_at,submitted_at,provider_request_id,uncertainty_reason,created_at,updated_at)
 VALUES (t.organization_id,t.workspace_id,v_checkout,1,'stripe_write','governance.billing.manage',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  NULL,NULL,NULL,'planned',morrow_work.sha256_text(array_to_json(ARRAY['morrow.billing.stripe_request','1','checkout_session_create',v_checkout,
   t.organization_id,t.workspace_id,v_intent,p_price_key,(extract(epoch FROM v_expires))::bigint::text,p_terms_revision])::text),
  0,NULL,NULL,NULL,NULL,v_at,v_at);
 SELECT * INTO o FROM morrow_work.operation_transition(t.organization_id,t.workspace_id,v_checkout,1,'authorized','action_service',
  'current_grants_and_preconditions',NULL,NULL,NULL);
 IF o.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
 INSERT INTO morrow_billing.checkout_intents(organization_id,workspace_id,id,revision,status,price_key,terms_revision,route_revision,mode,
  actor_principal_id,actor_membership_id,idempotency_key,request_digest,correlation_id,customer_operation_id,checkout_operation_id,stripe_session_id,
  expires_at,created_at,updated_at)
 VALUES (t.organization_id,t.workspace_id,v_intent,1,'open',p_price_key,v_terms.terms_revision,r.revision,v_mode,t.principal_id,t.membership_id,
  p_key,p_request_digest,p_correlation_id,v_customer_op,v_checkout,NULL,v_expires,v_at,v_at);
 IF v_new_customer THEN
  INSERT INTO morrow_billing.stripe_operations(organization_id,workspace_id,operation_id,purpose,checkout_intent_id,actor_principal_id,
   actor_membership_id,idempotency_key,request_digest,correlation_id,provider_object_id,created_at)
  VALUES (t.organization_id,t.workspace_id,v_customer_op,'customer_create',v_intent,t.principal_id,t.membership_id,NULL,NULL,p_correlation_id,NULL,v_at);
 END IF;
 INSERT INTO morrow_billing.stripe_operations(organization_id,workspace_id,operation_id,purpose,checkout_intent_id,actor_principal_id,
  actor_membership_id,idempotency_key,request_digest,correlation_id,provider_object_id,created_at)
 VALUES (t.organization_id,t.workspace_id,v_checkout,'checkout_session_create',v_intent,t.principal_id,t.membership_id,NULL,NULL,p_correlation_id,NULL,v_at);
 RETURN QUERY SELECT 'applied'::text,jsonb_build_object('intentId',v_intent,'status','open','customerOperationId',v_customer_op,
  'checkoutOperationId',v_checkout,'expiresAt',morrow_work.utc_text(v_expires))::text;
END $$;

-- Opens one customer portal session operation for a morrow_direct workspace with a
-- mapped customer. Outcomes: applied, replayed, invalid, ineligible, command_conflict,
-- stale_authority, route_conflict, customer_missing.
CREATE FUNCTION morrow_billing.cmd_portal_open(p_key text,p_request_digest text,p_correlation_id text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; s record; o record; v_check text; v_customer text; v_at timestamptz; v_id text;
BEGIN
 IF p_key IS NULL OR p_key !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_request_digest IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$'
  OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF COALESCE(pg_catalog.current_setting('morrow.billing_receipt_entered',true),'')<>'' THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text; RETURN;
 END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND OR t.principal_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_principal_id',true)
  OR t.membership_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_membership_id',true) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.billing.command',t.organization_id,t.workspace_id,t.principal_id,p_key)::text,0));
 IF EXISTS(SELECT 1 FROM morrow_billing.checkout_intents x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
   AND x.actor_principal_id=t.principal_id AND x.idempotency_key=p_key) THEN
  RETURN QUERY SELECT 'command_conflict'::text,NULL::text; RETURN;
 END IF;
 SELECT x.operation_id::text AS operation_id,x.request_digest::text AS request_digest INTO s FROM morrow_billing.stripe_operations x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.actor_principal_id=t.principal_id AND x.idempotency_key=p_key;
 IF FOUND THEN
  IF s.request_digest<>p_request_digest THEN RETURN QUERY SELECT 'command_conflict'::text,NULL::text; RETURN; END IF;
  RETURN QUERY SELECT 'replayed'::text,jsonb_build_object('operationId',s.operation_id)::text; RETURN;
 END IF;
 v_check:=morrow_identity.work_lock_and_recheck(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true),
  pg_catalog.current_setting('morrow.work_principal_id',true),pg_catalog.current_setting('morrow.work_membership_id',true),
  pg_catalog.current_setting('morrow.work_policy_revision',true),pg_catalog.current_setting('morrow.work_grants_digest',true),
  pg_catalog.current_setting('morrow.work_evaluated_at_us',true));
 IF v_check='ineligible' THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text; RETURN;
 ELSIF v_check IS DISTINCT FROM 'current' THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_billing.workspace_billing_routes x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
   AND x.route='morrow_direct') THEN
  RETURN QUERY SELECT 'route_conflict'::text,NULL::text; RETURN;
 END IF;
 SELECT x.stripe_customer_id INTO v_customer FROM morrow_billing.stripe_customers x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'customer_missing'::text,NULL::text; RETURN; END IF;
 v_at:=morrow_work.db_now(); v_id:=gen_random_uuid()::text;
 INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,task_id,store_id,connection_id,target_index,
  target_resource_id,proposal_id,proposal_digest,approval_id,approval_revision,approval_digest,claim_family_root_id,lease_id,status,
  request_digest,attempt,send_started_at,submitted_at,provider_request_id,uncertainty_reason,created_at,updated_at)
 VALUES (t.organization_id,t.workspace_id,v_id,1,'stripe_write','governance.billing.manage',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  NULL,NULL,NULL,'planned',morrow_work.sha256_text(array_to_json(ARRAY['morrow.billing.stripe_request','1','portal_session_create',v_id,
   t.organization_id,t.workspace_id,v_customer])::text),0,NULL,NULL,NULL,NULL,v_at,v_at);
 SELECT * INTO o FROM morrow_work.operation_transition(t.organization_id,t.workspace_id,v_id,1,'authorized','action_service',
  'current_grants_and_preconditions',NULL,NULL,NULL);
 IF o.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
 INSERT INTO morrow_billing.stripe_operations(organization_id,workspace_id,operation_id,purpose,checkout_intent_id,actor_principal_id,
  actor_membership_id,idempotency_key,request_digest,correlation_id,provider_object_id,created_at)
 VALUES (t.organization_id,t.workspace_id,v_id,'portal_session_create',NULL,t.principal_id,t.membership_id,p_key,p_request_digest,p_correlation_id,NULL,v_at);
 RETURN QUERY SELECT 'applied'::text,jsonb_build_object('operationId',v_id)::text;
END $$;

-- ---------------------------------------------------------------------------
-- Broker definers: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_vault_broker only, each guarded by work_executor_safe. Ids only; the
-- broker loads every Stripe parameter here, never from its caller.
-- Begins one send or reconciliation of a stripe_write operation, under its row lock.
-- authorized: authorized -> dispatching (the lease-free billing dispatch; there is no
-- lease and no grant to recheck after the session command), then the send fence
-- (send_started_at, attempt+1) before any HTTP call: 'send'. dispatching with the fence
-- set (a send may have happened): -> uncertain (unknown_submission): 'reconcile'.
-- uncertain: 'reconcile'. verified, failed: as they are. A checkout waits for its customer
-- and for an open intent. Outcomes: send, reconcile, verified, failed, customer_pending,
-- intent_closed, state_conflict, not_found, invalid, denied.
CREATE FUNCTION morrow_billing.stripe_op_begin(p_operation_id text)
RETURNS TABLE(outcome text,purpose text,status text,request_digest text,params text,provider_object_id text,created_at_ms text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE
 op record; so record; i record; v_customer text; v_params jsonb; v_at timestamptz; x record; v_status text;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT o.organization_id::text AS organization_id,o.workspace_id::text AS workspace_id,o.status,o.revision::bigint AS revision,
  o.request_digest::text AS request_digest,o.send_started_at,o.created_at INTO op
  FROM morrow_work.operations o WHERE o.id=p_operation_id AND o.kind='stripe_write' FOR UPDATE;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT s.purpose,s.checkout_intent_id::text AS checkout_intent_id,s.provider_object_id INTO so FROM morrow_billing.stripe_operations s
  WHERE s.organization_id=op.organization_id AND s.workspace_id=op.workspace_id AND s.operation_id=p_operation_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT c.stripe_customer_id INTO v_customer FROM morrow_billing.stripe_customers c
  WHERE c.organization_id=op.organization_id AND c.workspace_id=op.workspace_id;
 IF so.purpose='customer_create' THEN
  v_params:=jsonb_build_object('organizationId',op.organization_id,'workspaceId',op.workspace_id,'operationId',p_operation_id);
 ELSIF so.purpose='checkout_session_create' THEN
  SELECT x2.id::text AS id,x2.status,x2.price_key,x2.mode,x2.expires_at,x2.terms_revision::text AS terms_revision INTO i
   FROM morrow_billing.checkout_intents x2 WHERE x2.organization_id=op.organization_id AND x2.workspace_id=op.workspace_id AND x2.id=so.checkout_intent_id;
  v_params:=jsonb_build_object('organizationId',op.organization_id,'workspaceId',op.workspace_id,'operationId',p_operation_id,
   'intentId',i.id,'priceKey',i.price_key,'mode',i.mode,'expiresAt',(extract(epoch FROM i.expires_at))::bigint::text,
   'termsRevision',i.terms_revision,'customerId',v_customer);
  IF op.status='authorized' AND i.status<>'open' THEN
   RETURN QUERY SELECT 'intent_closed'::text,so.purpose,op.status,op.request_digest,v_params::text,so.provider_object_id,
    (extract(epoch FROM op.created_at)*1000)::bigint::text;
   RETURN;
  END IF;
  IF v_customer IS NULL THEN
   RETURN QUERY SELECT 'customer_pending'::text,so.purpose,op.status,op.request_digest,v_params::text,so.provider_object_id,
    (extract(epoch FROM op.created_at)*1000)::bigint::text;
   RETURN;
  END IF;
 ELSE
  v_params:=jsonb_build_object('organizationId',op.organization_id,'workspaceId',op.workspace_id,'operationId',p_operation_id,
   'customerId',v_customer);
 END IF;
 v_status:=op.status;
 IF op.status='authorized' THEN
  SELECT * INTO x FROM morrow_work.operation_transition(op.organization_id,op.workspace_id,p_operation_id,op.revision,'dispatching',
   'action_service','non_billable_current_grants_and_lease',NULL,NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
  v_at:=morrow_work.db_now();
  UPDATE morrow_work.operations o SET attempt=o.attempt+1,send_started_at=greatest(v_at,o.updated_at),revision=o.revision+1,
   updated_at=greatest(v_at,o.updated_at)
   WHERE o.organization_id=op.organization_id AND o.workspace_id=op.workspace_id AND o.id=p_operation_id;
  RETURN QUERY SELECT 'send'::text,so.purpose,'dispatching'::text,op.request_digest,v_params::text,NULL::text,
   (extract(epoch FROM op.created_at)*1000)::bigint::text;
  RETURN;
 END IF;
 IF op.status='dispatching' AND op.send_started_at IS NOT NULL THEN
  SELECT * INTO x FROM morrow_work.operation_transition(op.organization_id,op.workspace_id,p_operation_id,op.revision,'uncertain',
   'connector','unknown_external_outcome','send_unconfirmed','unknown_submission',NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
  v_status:='uncertain';
 END IF;
 RETURN QUERY SELECT CASE v_status WHEN 'uncertain' THEN 'reconcile' WHEN 'verified' THEN 'verified' WHEN 'failed' THEN 'failed'
   ELSE 'state_conflict' END,so.purpose,v_status,op.request_digest,v_params::text,so.provider_object_id,
  (extract(epoch FROM op.created_at)*1000)::bigint::text;
END $$;

-- Settles one stripe_write operation from the broker's provider result, under its row
-- lock. verified (dispatching -> submitted -> verifying -> verified, or uncertain ->
-- verifying -> verified): records the provider object once, and the customer mapping or
-- the intent's session id; failed (verified_no_effect, from dispatching or uncertain):
-- fails the operation's open intent; uncertain (from dispatching). Never promotes an
-- uncertain operation without a provider result. Outcomes: verified, already_verified,
-- failed, already_failed, uncertain, conflict, state_conflict, not_found, invalid, denied.
CREATE FUNCTION morrow_billing.stripe_op_settle(p_operation_id text,p_result text,p_provider_object_id text,p_provider_request_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE op record; so record; x record; i record; v_at timestamptz; v_mode text; v_rev bigint;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_result IS NULL OR p_result NOT IN ('verified','failed','uncertain')
  OR (p_result='verified')<>(p_provider_object_id IS NOT NULL)
  OR (p_provider_object_id IS NOT NULL AND p_provider_object_id !~ '^(cus|cs|bps)_[A-Za-z0-9_]{8,250}$')
  OR (p_provider_request_id IS NOT NULL AND p_provider_request_id !~ '^req_[A-Za-z0-9]{8,64}$') THEN
  RETURN 'invalid';
 END IF;
 SELECT o.organization_id::text AS organization_id,o.workspace_id::text AS workspace_id,o.status,o.revision::bigint AS revision,
  o.provider_request_id INTO op FROM morrow_work.operations o WHERE o.id=p_operation_id AND o.kind='stripe_write' FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 SELECT s.purpose,s.checkout_intent_id::text AS checkout_intent_id,s.provider_object_id INTO so FROM morrow_billing.stripe_operations s
  WHERE s.organization_id=op.organization_id AND s.workspace_id=op.workspace_id AND s.operation_id=p_operation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 IF p_result='verified' AND p_provider_object_id !~ (CASE so.purpose WHEN 'customer_create' THEN '^cus_[A-Za-z0-9]{8,100}$'
   WHEN 'checkout_session_create' THEN '^cs_' ELSE '^bps_' END) THEN
  RETURN 'invalid';
 END IF;
 v_rev:=op.revision;
 IF p_result='verified' THEN
  IF op.status='verified' THEN
   RETURN CASE WHEN so.provider_object_id=p_provider_object_id THEN 'already_verified' ELSE 'conflict' END;
  END IF;
  IF op.status NOT IN ('dispatching','uncertain') THEN RETURN 'state_conflict'; END IF;
  IF op.status='dispatching' THEN
   IF p_provider_request_id IS NOT NULL AND op.provider_request_id IS NULL THEN
    v_at:=morrow_work.db_now();
    UPDATE morrow_work.operations o SET provider_request_id=p_provider_request_id,revision=o.revision+1,updated_at=greatest(v_at,o.updated_at)
     WHERE o.organization_id=op.organization_id AND o.workspace_id=op.workspace_id AND o.id=p_operation_id;
    v_rev:=v_rev+1;
   END IF;
   SELECT * INTO x FROM morrow_work.operation_transition(op.organization_id,op.workspace_id,p_operation_id,v_rev,'submitted','connector',
    'provider_submission_receipt',NULL,NULL,NULL);
   IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
   SELECT * INTO x FROM morrow_work.operation_transition(op.organization_id,op.workspace_id,p_operation_id,x.revision,'verifying','connector',
    'provider_terminal_result',NULL,NULL,NULL);
  ELSE
   SELECT * INTO x FROM morrow_work.operation_transition(op.organization_id,op.workspace_id,p_operation_id,v_rev,'verifying','connector',
    'reconciled_provider_result',NULL,NULL,NULL);
  END IF;
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
  SELECT * INTO x FROM morrow_work.operation_transition(op.organization_id,op.workspace_id,p_operation_id,x.revision,'verified','action_service',
   'declared_postconditions_verified',NULL,NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
  UPDATE morrow_billing.stripe_operations s SET provider_object_id=p_provider_object_id
   WHERE s.organization_id=op.organization_id AND s.workspace_id=op.workspace_id AND s.operation_id=p_operation_id;
  v_at:=morrow_work.db_now();
  IF so.purpose='customer_create' THEN
   SELECT x2.mode INTO v_mode FROM morrow_billing.checkout_intents x2 WHERE x2.organization_id=op.organization_id
    AND x2.workspace_id=op.workspace_id AND x2.id=so.checkout_intent_id;
   INSERT INTO morrow_billing.stripe_customers(organization_id,workspace_id,stripe_customer_id,mode,created_by_operation_id,created_at)
   VALUES (op.organization_id,op.workspace_id,p_provider_object_id,v_mode,p_operation_id,v_at);
  ELSIF so.purpose='checkout_session_create' THEN
   UPDATE morrow_billing.checkout_intents x2 SET stripe_session_id=p_provider_object_id,revision=x2.revision+1,updated_at=greatest(v_at,x2.updated_at)
    WHERE x2.organization_id=op.organization_id AND x2.workspace_id=op.workspace_id AND x2.id=so.checkout_intent_id
     AND x2.status='open' AND x2.stripe_session_id IS NULL;
  END IF;
  RETURN 'verified';
 END IF;
 IF p_result='failed' THEN
  IF op.status='failed' THEN RETURN 'already_failed'; END IF;
  IF op.status NOT IN ('dispatching','uncertain') THEN RETURN 'state_conflict'; END IF;
  SELECT * INTO x FROM morrow_work.operation_transition(op.organization_id,op.workspace_id,p_operation_id,v_rev,'failed',
   CASE op.status WHEN 'dispatching' THEN 'connector' ELSE 'action_service' END,'verified_no_effect',NULL,NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
  IF so.checkout_intent_id IS NOT NULL THEN
   v_at:=morrow_work.db_now();
   UPDATE morrow_billing.checkout_intents x2 SET status='failed',revision=x2.revision+1,updated_at=greatest(v_at,x2.updated_at)
    WHERE x2.organization_id=op.organization_id AND x2.workspace_id=op.workspace_id AND x2.id=so.checkout_intent_id AND x2.status='open';
  END IF;
  RETURN 'failed';
 END IF;
 IF op.status='uncertain' THEN RETURN 'uncertain'; END IF;
 IF op.status<>'dispatching' THEN RETURN 'state_conflict'; END IF;
 SELECT * INTO x FROM morrow_work.operation_transition(op.organization_id,op.workspace_id,p_operation_id,v_rev,'uncertain','connector',
  'unknown_external_outcome','send_unconfirmed','transport_after_dispatch',NULL);
 IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'BILLING_OPERATION_INVALID'; END IF;
 RETURN 'uncertain';
END $$;

-- The closed normalised object of one receipt (packages/work/src/billing/stripe-objects.ts):
-- exact keys per kind, ids, integer amounts as strings, lowercase currency, whole-second
-- Unix times as strings. Owned by the owner; EXECUTE for the command role (the definers).
CREATE FUNCTION morrow_billing.receipt_object_valid(p_kind text,p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE(jsonb_typeof(p)='object' AND p->>'kind'=p_kind AND jsonb_typeof(p->'livemode')='boolean'
  AND p->>'customer' ~ '^cus_[A-Za-z0-9]{8,100}$'
  AND jsonb_typeof(p->'metadata')='object'
  AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p->'metadata') k)=ARRAY['operationId','organizationId','workspaceId']
  AND (p->'metadata'->'operationId'='null'::jsonb OR p->'metadata'->>'operationId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
  AND (p->'metadata'->'organizationId'='null'::jsonb OR p->'metadata'->>'organizationId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  AND (p->'metadata'->'workspaceId'='null'::jsonb OR p->'metadata'->>'workspaceId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  AND CASE p_kind
   WHEN 'invoice' THEN (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p) k)=ARRAY['amountPaid','billingReason','currency','customer','id',
     'kind','livemode','metadata','periodEnd','periodStart','price','status','subscription','subscriptionState']
    AND p->>'id' ~ '^in_[A-Za-z0-9]{8,100}$' AND p->>'status' IN ('draft','open','paid','uncollectible','void')
    AND (p->'billingReason'='null'::jsonb OR p->>'billingReason' ~ '^[a-z][a-z_]{0,63}$')
    AND jsonb_typeof(p->'amountPaid')='string' AND p->>'amountPaid' ~ '^(0|[1-9][0-9]{0,15})$' AND p->>'currency' ~ '^[a-z]{3}$'
    AND (p->'subscription'='null'::jsonb OR p->>'subscription' ~ '^sub_[A-Za-z0-9]{8,100}$')
    AND (p->'price'='null'::jsonb OR p->>'price' ~ '^price_[A-Za-z0-9]{8,100}$')
    AND (p->'periodStart'='null'::jsonb OR (jsonb_typeof(p->'periodStart')='string' AND p->>'periodStart' ~ '^[1-9][0-9]{8,10}$'))
    AND (p->'periodEnd'='null'::jsonb OR (jsonb_typeof(p->'periodEnd')='string' AND p->>'periodEnd' ~ '^[1-9][0-9]{8,10}$'))
    AND (p->'subscriptionState'='null'::jsonb OR (jsonb_typeof(p->'subscriptionState')='object'
     AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p->'subscriptionState') k)=ARRAY['cancelAt','cancelAtPeriodEnd','currentPeriodEnd','status']
     AND p->'subscriptionState'->>'status' IN ('active','trialing','incomplete','incomplete_expired','past_due','unpaid','paused','canceled')
     AND jsonb_typeof(p->'subscriptionState'->'cancelAtPeriodEnd')='boolean'
     AND (p->'subscriptionState'->'cancelAt'='null'::jsonb OR p->'subscriptionState'->>'cancelAt' ~ '^[1-9][0-9]{8,10}$')
     AND (p->'subscriptionState'->'currentPeriodEnd'='null'::jsonb OR p->'subscriptionState'->>'currentPeriodEnd' ~ '^[1-9][0-9]{8,10}$')))
   WHEN 'subscription' THEN (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p) k)=ARRAY['cancelAt','cancelAtPeriodEnd','currentPeriodEnd',
     'customer','id','kind','livemode','metadata','price','status']
    AND p->>'id' ~ '^sub_[A-Za-z0-9]{8,100}$'
    AND p->>'status' IN ('active','trialing','incomplete','incomplete_expired','past_due','unpaid','paused','canceled')
    AND jsonb_typeof(p->'cancelAtPeriodEnd')='boolean'
    AND (p->'cancelAt'='null'::jsonb OR p->>'cancelAt' ~ '^[1-9][0-9]{8,10}$')
    AND (p->'currentPeriodEnd'='null'::jsonb OR p->>'currentPeriodEnd' ~ '^[1-9][0-9]{8,10}$')
    AND (p->'price'='null'::jsonb OR p->>'price' ~ '^price_[A-Za-z0-9]{8,100}$')
   WHEN 'checkout_session' THEN (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p) k)=ARRAY['customer','id','kind','livemode','metadata',
     'status','subscription']
    AND p->>'id' ~ '^cs_[A-Za-z0-9_]{8,250}$' AND p->>'status' IN ('open','complete','expired')
    AND (p->'subscription'='null'::jsonb OR p->>'subscription' ~ '^sub_[A-Za-z0-9]{8,100}$')
   ELSE false END,false)
$$;

-- Records one verified event after the broker's signature check and readback. The tenant
-- comes only from the customer mapping of this mode (none: unattributed). Duplicate event
-- ids return the existing receipt. Outcomes: recorded, duplicate, invalid, denied.
CREATE FUNCTION morrow_billing.stripe_receipt_record(p_event_id text,p_event_type text,p_livemode text,p_object_type text,p_object_id text,
 p_customer_id text,p_object_json text,p_object_digest text,p_observed_at text)
RETURNS TABLE(outcome text,receipt_id text,attributed text,object_digest text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE v_object jsonb; v_live boolean; v_mode text; c record; v_id text; v_observed timestamptz; v_at timestamptz; e record; n integer;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_event_id IS NULL OR p_event_id !~ '^evt_[A-Za-z0-9_]{8,250}$' OR p_livemode IS NULL OR p_livemode NOT IN ('true','false')
  OR p_object_type IS NULL OR p_object_type NOT IN ('invoice','subscription','checkout_session') OR p_object_id IS NULL
  OR p_customer_id IS NULL OR p_customer_id !~ '^cus_[A-Za-z0-9]{8,100}$'
  OR p_object_json IS NULL OR octet_length(p_object_json)>8192 OR p_object_digest IS NULL OR p_object_digest !~ '^[a-f0-9]{64}$'
  OR p_observed_at IS NULL OR p_observed_at !~ '^[1-9][0-9]{11,13}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 BEGIN v_object:=p_object_json::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END;
 v_live:=p_livemode='true'; v_mode:=CASE WHEN v_live THEN 'live' ELSE 'test' END;
 IF NOT morrow_billing.receipt_object_valid(p_object_type,v_object) OR v_object->>'id'<>p_object_id OR v_object->>'customer'<>p_customer_id
  OR v_object->'livemode'<>to_jsonb(v_live) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_observed:=timestamptz 'epoch'+(p_observed_at||' milliseconds')::interval;
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id INTO c FROM morrow_billing.stripe_customers x
  WHERE x.stripe_customer_id=p_customer_id AND x.mode=v_mode;
 v_id:=gen_random_uuid()::text; v_at:=morrow_work.db_now();
 INSERT INTO morrow_billing.stripe_event_receipts(organization_id,workspace_id,id,event_id,event_type,livemode,mode,object_type,object_id,
  customer_id,object,object_digest,observed_at,recorded_at)
 VALUES (c.organization_id,c.workspace_id,v_id,p_event_id,p_event_type,v_live,v_mode,p_object_type,p_object_id,p_customer_id,v_object,
  p_object_digest,v_observed,v_at)
 ON CONFLICT (event_id) DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n=1 THEN
  RETURN QUERY SELECT 'recorded'::text,v_id,(c.organization_id IS NOT NULL)::text,p_object_digest; RETURN;
 END IF;
 SELECT x.id::text AS id,x.organization_id,x.object_digest::text AS object_digest INTO e FROM morrow_billing.stripe_event_receipts x
  WHERE x.event_id=p_event_id;
 RETURN QUERY SELECT 'duplicate'::text,e.id,(e.organization_id IS NOT NULL)::text,e.object_digest;
END $$;

-- ---------------------------------------------------------------------------
-- The receipt-only ingress (ADR-0022 item 9 amendment, 2026-10-20): SECURITY DEFINER,
-- owned by the command role after the transfer, EXECUTE for morrow_work_api; each refuses
-- unless the session user is morrow_api_worker with no work session context
-- (receipt_ingress), and takes the tenant only from the recorded receipt.
-- Begins the application of one recorded receipt whose digest matches: the receipt lock,
-- the entry proof, and for an attributed receipt the route row's lock; returns the
-- receipt and its tenant's billing facts. Outcomes: begun, already_applied, not_found,
-- digest_mismatch, invalid, denied.
CREATE FUNCTION morrow_billing.receipt_begin(p_receipt_id text,p_object_digest text)
RETURNS TABLE(outcome text,facts text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE rc record; ap record; v_nonce text; v_xact text; n integer; v_org text; v_ws text; v_facts jsonb; v_key text; v_op text;
 v_intent text;
BEGIN
 IF NOT morrow_billing.receipt_ingress() OR COALESCE(pg_catalog.current_setting('morrow.billing_receipt_entered',true),'')<>''
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
   AND NOT r.rolcreaterole AND NOT r.rolinherit) THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN;
 END IF;
 IF p_receipt_id IS NULL OR p_receipt_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_object_digest IS NULL OR p_object_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_xact:=pg_catalog.pg_current_xact_id()::text;
 IF EXISTS(SELECT 1 FROM morrow_billing.receipt_entries e WHERE e.backend_pid=pg_catalog.pg_backend_pid() AND e.xact_id=v_xact) THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.billing.receipt',p_receipt_id)::text,0));
 SELECT x.id::text AS id,x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.event_id,x.event_type,x.livemode,x.mode,
  x.object_type,x.object_id,x.customer_id,x.object,x.object_digest::text AS object_digest,x.observed_at INTO rc
  FROM morrow_billing.stripe_event_receipts x WHERE x.id=p_receipt_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF rc.object_digest<>p_object_digest THEN RETURN QUERY SELECT 'digest_mismatch'::text,NULL::text; RETURN; END IF;
 SELECT a.outcome,a.outcome_code INTO ap FROM morrow_billing.receipt_applications a WHERE a.receipt_id=p_receipt_id;
 IF FOUND THEN
  RETURN QUERY SELECT 'already_applied'::text,jsonb_build_object('outcome',ap.outcome,'code',ap.outcome_code)::text; RETURN;
 END IF;
 -- The entry proof: one row per backend, naming this transaction, receipt and tenant.
 v_nonce:=gen_random_uuid()::text;
 UPDATE morrow_billing.receipt_entries e SET xact_id=v_xact,receipt_id=p_receipt_id,receipt_organization_id=rc.organization_id,
  receipt_workspace_id=rc.workspace_id,nonce=v_nonce WHERE e.backend_pid=pg_catalog.pg_backend_pid();
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n=0 THEN
  INSERT INTO morrow_billing.receipt_entries(backend_pid,xact_id,receipt_id,receipt_organization_id,receipt_workspace_id,nonce)
  VALUES (pg_catalog.pg_backend_pid(),v_xact,p_receipt_id,rc.organization_id,rc.workspace_id,v_nonce);
 END IF;
 PERFORM pg_catalog.set_config('morrow.billing_receipt_entered',v_nonce,true);
 v_org:=rc.organization_id; v_ws:=rc.workspace_id;
 v_facts:=jsonb_build_object('receipt',jsonb_build_object('id',rc.id,'organizationId',v_org,'workspaceId',v_ws,'eventId',rc.event_id,
  'eventType',rc.event_type,'livemode',rc.livemode,'mode',rc.mode,'objectType',rc.object_type,'objectId',rc.object_id,
  'customerId',rc.customer_id,'object',rc.object,'objectDigest',rc.object_digest,'observedAt',morrow_work.utc_text(rc.observed_at)));
 IF v_org IS NULL THEN
  RETURN QUERY SELECT 'begun'::text,v_facts::text; RETURN;
 END IF;
 -- Serialise with checkout and every other application in this workspace.
 PERFORM 1 FROM morrow_billing.workspace_billing_routes x WHERE x.organization_id=v_org AND x.workspace_id=v_ws FOR UPDATE;
 v_key:=CASE WHEN rc.object_type='invoice' THEN 'stripe:invoice:'||rc.object_id END;
 v_op:=rc.object->'metadata'->>'operationId';
 SELECT x.checkout_intent_id::text INTO v_intent FROM morrow_billing.stripe_operations x WHERE x.organization_id=v_org AND x.workspace_id=v_ws
  AND x.operation_id=v_op AND x.purpose='checkout_session_create';
 IF v_intent IS NULL AND rc.object_type='checkout_session' THEN
  SELECT x.id::text INTO v_intent FROM morrow_billing.checkout_intents x WHERE x.organization_id=v_org AND x.workspace_id=v_ws
   AND x.stripe_session_id=rc.object_id;
 END IF;
 v_facts:=v_facts||jsonb_build_object(
  'route',(SELECT to_jsonb(y) FROM (SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.origin,
    morrow_work.utc_text(x.shopify_bound_at) AS shopify_bound_at,x.route,x.mode,morrow_work.utc_text(x.route_fixed_at) AS route_fixed_at,
    x.fixing_payment_key,x.revision::text AS revision FROM morrow_billing.workspace_billing_routes x
    WHERE x.organization_id=v_org AND x.workspace_id=v_ws) y),
  'associations',COALESCE((SELECT jsonb_agg(to_jsonb(y) ORDER BY y.linked_at,y.installation_id) FROM (SELECT a.installation_id,a.store_id,
    a.connection_id,a.status,morrow_work.utc_text(date_trunc('milliseconds',a.linked_at)) AS linked_at
    FROM morrow_identity.work_store_installations(v_org,v_ws) a) y),'[]'::jsonb),
  'account',(SELECT to_jsonb(y) FROM (SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.id::text AS id,
    x.route,x.mode,x.currency,x.status,x.revision::text AS revision FROM morrow_billing.billing_accounts x
    WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.route='morrow_direct') y),
  'snapshot',(SELECT to_jsonb(y) FROM (SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,
    x.billing_account_id::text AS billing_account_id,x.revision::text AS revision,x.route,x.mode,x.subscription_key,x.status,
    x.provider_evidence_ref::text AS provider_evidence_ref,morrow_work.utc_text(x.verified_at) AS verified_at,
    morrow_work.utc_text(x.valid_until) AS valid_until FROM morrow_billing.entitlement_snapshots x
    WHERE x.organization_id=v_org AND x.workspace_id=v_ws ORDER BY x.revision DESC LIMIT 1) y),
  'conflicts',COALESCE((SELECT jsonb_agg(to_jsonb(y) ORDER BY y.subscription_key) FROM (SELECT DISTINCT ON (x.subscription_key) x.route,
    x.subscription_key,x.outcome_code AS code FROM morrow_billing.verified_payment_events x WHERE x.organization_id=v_org
    AND x.workspace_id=v_ws AND x.outcome='conflict' ORDER BY x.subscription_key,x.recorded_at DESC,x.id::text COLLATE "C" DESC) y),'[]'::jsonb),
  'intentPending',EXISTS(SELECT 1 FROM morrow_billing.checkout_intents x WHERE x.organization_id=v_org AND x.workspace_id=v_ws
    AND x.status IN ('open','completed')),
  'terms',(SELECT jsonb_build_object('termsRevision',x.terms_revision::text,'terms',x.terms) FROM morrow_billing.billing_terms x
    ORDER BY x.terms_revision DESC LIMIT 1),
  'payment',CASE WHEN v_key IS NULL THEN NULL ELSE jsonb_build_object('paymentKey',v_key,
    'granted',EXISTS(SELECT 1 FROM morrow_billing.credit_grants g WHERE g.route='morrow_direct' AND g.mode=rc.mode AND g.payment_key=v_key),
    'recorded',EXISTS(SELECT 1 FROM morrow_billing.verified_payment_events g WHERE g.route='morrow_direct' AND g.mode=rc.mode AND g.payment_key=v_key))
   END,
  'checkoutOperation',(SELECT CASE WHEN v_intent IS NULL AND v_op IS NULL THEN NULL ELSE jsonb_build_object('operationId',
    (SELECT x.operation_id::text FROM morrow_billing.stripe_operations x WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.operation_id=v_op
     AND x.purpose='checkout_session_create'),'intentId',v_intent) END),
  'intent',(SELECT to_jsonb(y) FROM (SELECT x.id::text AS id,x.status,x.revision::text AS revision FROM morrow_billing.checkout_intents x
    WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.id=v_intent) y));
 RETURN QUERY SELECT 'begun'::text,v_facts::text;
END $$;

-- Applies one begun receipt from the api's closed plan (packages/work/src/billing/apply-plan.ts)
-- in the same transaction. Everything that moves money or authority is re-derived here from
-- the recorded receipt and billing_terms, never taken from the plan: the payment key, mode,
-- amount, price, period, operation and credit units; the route fix only for a workspace in
-- phase open; a grant only for a paid, non-zero, Morrow-initiated subscription-period
-- invoice whose price is in the current terms; the snapshot's status and validity from the
-- read-back subscription. The plan only chooses among outcomes the receipt allows, and a
-- plan that withholds a grant can only deny. Outcomes: applied, already_applied, invalid,
-- denied, conflict.
CREATE FUNCTION morrow_billing.receipt_apply(p_receipt_id text,p_object_digest text,p_plan text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE
 rc record; v_plan jsonb; v_outcome text; v_code text; v_pay jsonb; v_snap jsonb; v_int jsonb; o jsonb; v_at timestamptz;
 v_org text; v_ws text; v_mode text; v_key text; v_kind text; v_sub text; v_price text; v_cents bigint; v_amount text; v_currency text;
 v_start timestamptz; v_end timestamptz; v_op text; v_units bigint; v_count integer; v_entry jsonb; v_terms record; r record; a record; s record;
 w record; i record; v_action text; v_vpe_outcome text; v_vpe_code text; v_account text; v_state jsonb; v_status text; v_valid timestamptz;
 v_snap_sub text; v_granted bigint; v_fixed boolean:=false; v_linked boolean; v_new_account boolean:=false;
BEGIN
 IF p_receipt_id IS NULL OR p_receipt_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_object_digest IS NULL OR p_object_digest !~ '^[a-f0-9]{64}$' OR p_plan IS NULL OR octet_length(p_plan)>4096 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF NOT morrow_billing.receipt_entered(p_receipt_id) THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT x.id::text AS id,x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.event_type,x.mode,x.object_type,
  x.object_id,x.object,x.object_digest::text AS object_digest,x.observed_at INTO rc
  FROM morrow_billing.stripe_event_receipts x WHERE x.id=p_receipt_id;
 IF NOT FOUND OR rc.object_digest<>p_object_digest THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_billing.receipt_applications x WHERE x.receipt_id=p_receipt_id) THEN
  RETURN QUERY SELECT 'already_applied'::text,NULL::text; RETURN;
 END IF;
 BEGIN v_plan:=p_plan::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 IF jsonb_typeof(v_plan)<>'object'
  OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_plan) k) IS DISTINCT FROM ARRAY['code','intent','outcome','payment','schemaVersion','snapshot']
  OR v_plan->'schemaVersion'<>'1'::jsonb
  OR v_plan->>'outcome' NOT IN ('applied','held','conflict','no_charge','refused','already_granted','ignored')
  OR NOT (v_plan->'code'='null'::jsonb OR (jsonb_typeof(v_plan->'code')='string' AND v_plan->>'code' ~ '^[A-Z][A-Z_]{2,63}$')) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_outcome:=v_plan->>'outcome'; v_code:=v_plan->>'code'; v_pay:=v_plan->'payment'; v_snap:=v_plan->'snapshot'; v_int:=v_plan->'intent';
 o:=rc.object; v_org:=rc.organization_id; v_ws:=rc.workspace_id; v_mode:=rc.mode; v_at:=morrow_work.db_now();
 -- An unattributed receipt (no customer mapping) is only recorded as held.
 IF v_org IS NULL THEN
  IF v_outcome<>'held' OR v_code IS DISTINCT FROM 'CUSTOMER_NOT_MAPPED' OR v_pay<>'null'::jsonb OR v_snap<>'null'::jsonb OR v_int<>'null'::jsonb THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  INSERT INTO morrow_billing.receipt_applications(organization_id,workspace_id,receipt_id,outcome,outcome_code,applied_at)
  VALUES (NULL,NULL,p_receipt_id,'held','CUSTOMER_NOT_MAPPED',v_at);
  RETURN QUERY SELECT 'applied'::text,jsonb_build_object('outcome','held','code','CUSTOMER_NOT_MAPPED','creditUnits',NULL,'routeFixed',false)::text;
  RETURN;
 END IF;
 SELECT x.origin,x.shopify_bound_at,x.route,x.mode,x.revision::bigint AS revision INTO r FROM morrow_billing.workspace_billing_routes x
  WHERE x.organization_id=v_org AND x.workspace_id=v_ws FOR UPDATE;
 SELECT x.id::text AS id,x.status,x.mode INTO a FROM morrow_billing.billing_accounts x WHERE x.organization_id=v_org AND x.workspace_id=v_ws
  AND x.route='morrow_direct';
 v_account:=a.id;
 -- The operation a Stripe object traces to: its metadata names this workspace (and
 -- organization, when present) and a checkout operation of this tenant; otherwise none.
 v_op:=o->'metadata'->>'operationId';
 IF v_op IS NOT NULL AND (o->'metadata'->>'workspaceId' IS DISTINCT FROM v_ws
   OR (o->'metadata'->'organizationId'<>'null'::jsonb AND o->'metadata'->>'organizationId'<>v_org)
   OR NOT EXISTS(SELECT 1 FROM morrow_billing.stripe_operations x WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.operation_id=v_op
    AND x.purpose='checkout_session_create')) THEN
  v_op:=NULL;
 END IF;
 -- Payment (invoice.paid only).
 IF v_pay<>'null'::jsonb THEN
  IF rc.event_type<>'invoice.paid' OR rc.object_type<>'invoice' OR jsonb_typeof(v_pay)<>'object'
   OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_pay) k) IS DISTINCT FROM ARRAY['action','code','outcome','termsRevision']
   OR v_pay->>'action' NOT IN ('fix_route_and_grant','grant','record') THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  v_action:=v_pay->>'action'; v_vpe_outcome:=v_pay->>'outcome'; v_vpe_code:=v_pay->>'code';
  v_key:='stripe:invoice:'||(o->>'id');
  v_kind:=CASE WHEN o->>'billingReason' IN ('subscription_create','subscription_cycle') THEN 'subscription_period' END;
  v_currency:=upper(o->>'currency');
  IF v_kind IS NULL OR v_currency<>'USD' OR o->'subscription'='null'::jsonb OR o->'price'='null'::jsonb
   OR o->'periodStart'='null'::jsonb OR o->'periodEnd'='null'::jsonb
   OR EXISTS(SELECT 1 FROM morrow_billing.verified_payment_events x WHERE x.route='morrow_direct' AND x.mode=v_mode AND x.payment_key=v_key) THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  v_sub:='stripe:sub:'||(o->>'subscription'); v_price:='stripe:price:'||(o->>'price');
  v_cents:=(o->>'amountPaid')::bigint; v_amount:=(v_cents::numeric/100)::numeric(20,2)::text;
  v_start:=timestamptz 'epoch'+((o->>'periodStart')||' seconds')::interval; v_end:=timestamptz 'epoch'+((o->>'periodEnd')||' seconds')::interval;
  IF v_end<=v_start THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  SELECT x.terms_revision::bigint AS terms_revision,x.terms INTO v_terms FROM morrow_billing.billing_terms x ORDER BY x.terms_revision DESC LIMIT 1;
  IF NOT FOUND OR v_pay->'termsRevision'<>to_jsonb(v_terms.terms_revision) THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text; RETURN;
  END IF;
  SELECT count(*)::integer,(array_agg(e))[1] INTO v_count,v_entry FROM jsonb_array_elements(v_terms.terms->'entries') e
   WHERE e->>'route'='morrow_direct' AND e->>'mode'=v_mode AND e->>'priceKey'=v_price AND e->>'kind'='subscription_period'
    AND e->>'currency'=v_currency;
  v_units:=CASE WHEN v_count=1 THEN (v_entry->>'creditUnits')::bigint END;
  v_linked:=EXISTS(SELECT 1 FROM morrow_identity.work_store_installations(v_org,v_ws));
  IF v_action IN ('fix_route_and_grant','grant') THEN
   IF v_vpe_outcome<>'granted' OR v_pay->'code'<>'null'::jsonb OR v_outcome<>'applied' OR o->>'status'<>'paid' OR v_cents<=0
    OR v_op IS NULL OR v_units IS NULL OR v_units<=0 THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
   END IF;
   IF v_action='fix_route_and_grant' THEN
    -- Phase open only (P01.T04a R2, R3): website origin, never bound, no association.
    IF r.route IS NOT NULL OR r.origin IS DISTINCT FROM 'website' OR r.shopify_bound_at IS NOT NULL OR v_linked OR v_account IS NOT NULL
     OR v_snap='null'::jsonb THEN
     RETURN QUERY SELECT 'conflict'::text,NULL::text; RETURN;
    END IF;
    v_account:=gen_random_uuid()::text; v_new_account:=true;
    INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at)
    VALUES (v_org,v_ws,v_account,'morrow_direct',v_mode,v_currency,'active',1,v_at,v_at);
    INSERT INTO morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,
     terms_revision,revision,created_at,updated_at)
    VALUES (v_org,v_ws,v_account,0,0,0,1,v_terms.terms_revision,1,v_at,v_at);
    UPDATE morrow_billing.workspace_billing_routes x SET route='morrow_direct',mode=v_mode,route_fixed_at=greatest(v_at,x.created_at),
     fixing_payment_key=v_key,revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
     WHERE x.organization_id=v_org AND x.workspace_id=v_ws;
    v_fixed:=true;
   ELSE
    -- A later period of the current subscription on the morrow_direct route.
    SELECT x.subscription_key,x.status INTO s FROM morrow_billing.entitlement_snapshots x WHERE x.organization_id=v_org AND x.workspace_id=v_ws
     AND x.billing_account_id=v_account ORDER BY x.revision DESC LIMIT 1;
    IF r.route IS DISTINCT FROM 'morrow_direct' OR r.mode IS DISTINCT FROM v_mode OR v_account IS NULL
     OR s.subscription_key IS DISTINCT FROM v_sub OR s.status='cancelled' THEN
     RETURN QUERY SELECT 'conflict'::text,NULL::text; RETURN;
    END IF;
   END IF;
  ELSE
   -- Recorded without a grant: only a non-granting classification of this payment.
   IF v_vpe_outcome NOT IN ('held','no_charge','conflict') OR v_outcome NOT IN ('held','no_charge','conflict')
    OR (v_vpe_outcome='no_charge')<>(v_pay->'code'='null'::jsonb)
    OR (v_vpe_outcome='no_charge' AND v_cents<>0)
    OR (v_vpe_code='NOT_MORROW_INITIATED' AND v_op IS NOT NULL)
    OR (v_vpe_code='TERMS_MISMATCH' AND v_units IS NOT NULL)
    OR (v_vpe_code='ROUTE_MISMATCH' AND r.route IS NOT DISTINCT FROM 'morrow_direct') THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
   END IF;
  END IF;
  INSERT INTO morrow_billing.verified_payment_events(organization_id,workspace_id,id,route,mode,payment_key,kind,subscription_key,price_key,
   period_start,period_end,operation_id,amount,currency,provider_evidence_ref,verified_at,outcome,outcome_code,receipt_id,recorded_at)
  VALUES (v_org,v_ws,gen_random_uuid()::text,'morrow_direct',v_mode,v_key,v_kind,v_sub,v_price,v_start,v_end,v_op,v_amount,v_currency,
   rc.object_digest,rc.observed_at,v_vpe_outcome,v_vpe_code,p_receipt_id,v_at);
  IF v_vpe_outcome='granted' THEN
   SELECT x.revision::bigint AS revision INTO w FROM morrow_billing.credit_wallets x WHERE x.organization_id=v_org AND x.workspace_id=v_ws
    AND x.billing_account_id=v_account FOR UPDATE;
   INSERT INTO morrow_billing.credit_grants(organization_id,workspace_id,id,billing_account_id,route,mode,payment_key,kind,credit_units,
    terms_revision,purchase_evidence_ref,effective_at,expires_at,funded_wallet_revision,recorded_at)
   VALUES (v_org,v_ws,gen_random_uuid()::text,v_account,'morrow_direct',v_mode,v_key,'included',v_units,v_terms.terms_revision,rc.object_digest,
    rc.observed_at,NULL,w.revision+1,v_at);
   UPDATE morrow_billing.credit_wallets x SET available=x.available+v_units,revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
    WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.billing_account_id=v_account;
   v_granted:=v_units;
  END IF;
 ELSIF rc.event_type='invoice.paid' AND v_outcome NOT IN ('held','refused','already_granted','ignored') THEN
  -- An invoice.paid without its payment record is only held (no derivable period),
  -- refused (mode), already granted or already recorded.
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 -- The entitlement fold: the next snapshot from the read-back subscription.
 IF v_snap<>'null'::jsonb THEN
  IF jsonb_typeof(v_snap)<>'object' OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_snap) k) IS DISTINCT FROM ARRAY['revision']
   OR v_account IS NULL OR rc.object_type='checkout_session' THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  IF rc.object_type='invoice' THEN
   v_state:=o->'subscriptionState'; v_snap_sub:='stripe:sub:'||(o->>'subscription');
  ELSE
   v_state:=o; v_snap_sub:='stripe:sub:'||(o->>'id');
  END IF;
  IF v_state IS NULL OR v_state='null'::jsonb OR v_snap_sub IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  v_status:=CASE v_state->>'status' WHEN 'active' THEN 'active' WHEN 'trialing' THEN 'pending' WHEN 'incomplete' THEN 'pending'
   WHEN 'incomplete_expired' THEN 'cancelled' WHEN 'past_due' THEN 'past_due' WHEN 'unpaid' THEN 'suspended' WHEN 'paused' THEN 'suspended'
   WHEN 'canceled' THEN 'cancelled' END;
  v_valid:=COALESCE(least(timestamptz 'epoch'+((v_state->>'currentPeriodEnd')||' seconds')::interval,
   timestamptz 'epoch'+((v_state->>'cancelAt')||' seconds')::interval),rc.observed_at);
  SELECT x.revision::bigint AS revision,x.subscription_key,x.status INTO s FROM morrow_billing.entitlement_snapshots x
   WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.billing_account_id=v_account ORDER BY x.revision DESC LIMIT 1;
  IF v_status IS NULL OR v_snap->'revision'<>to_jsonb(COALESCE(s.revision,0)+1)
   OR (s.subscription_key IS NOT NULL AND s.subscription_key<>v_snap_sub AND s.status<>'cancelled') THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text; RETURN;
  END IF;
  INSERT INTO morrow_billing.entitlement_snapshots(organization_id,workspace_id,billing_account_id,revision,route,mode,subscription_key,status,
   provider_evidence_ref,verified_at,valid_until,receipt_id,recorded_at)
  VALUES (v_org,v_ws,v_account,COALESCE(s.revision,0)+1,'morrow_direct',v_mode,v_snap_sub,v_status,rc.object_digest,rc.observed_at,v_valid,
   p_receipt_id,v_at);
  -- The account follows its subscription: past_due stays active (the snapshot says so).
  UPDATE morrow_billing.billing_accounts x SET status=CASE v_status WHEN 'past_due' THEN 'active' ELSE v_status END,revision=x.revision+1,
   updated_at=greatest(v_at,x.updated_at)
   WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.id=v_account AND x.status<>CASE v_status WHEN 'past_due' THEN 'active' ELSE v_status END;
 END IF;
 -- The intent this receipt traces to.
 IF v_int<>'null'::jsonb THEN
  IF jsonb_typeof(v_int)<>'object' OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_int) k) IS DISTINCT FROM ARRAY['intentId','to']
   OR v_int->>'to' NOT IN ('completed','expired','verified') THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  SELECT x.id::text AS id,x.status,x.stripe_session_id,x.checkout_operation_id::text AS checkout_operation_id INTO i
   FROM morrow_billing.checkout_intents x WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.id=v_int->>'intentId' FOR UPDATE;
  IF NOT FOUND
   OR NOT (i.checkout_operation_id=o->'metadata'->>'operationId' OR (rc.object_type='checkout_session' AND i.stripe_session_id=rc.object_id))
   OR (v_int->>'to'='completed' AND NOT (rc.event_type='checkout.session.completed' AND o->>'status'='complete' AND i.status='open'))
   OR (v_int->>'to'='expired' AND NOT (rc.event_type='checkout.session.expired' AND o->>'status'='expired' AND i.status='open'))
   OR (v_int->>'to'='verified' AND NOT (v_granted IS NOT NULL AND v_op=i.checkout_operation_id AND i.status IN ('open','completed'))) THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  UPDATE morrow_billing.checkout_intents x SET status=v_int->>'to',revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
   WHERE x.organization_id=v_org AND x.workspace_id=v_ws AND x.id=i.id;
 END IF;
 INSERT INTO morrow_billing.receipt_applications(organization_id,workspace_id,receipt_id,outcome,outcome_code,applied_at)
 VALUES (v_org,v_ws,p_receipt_id,v_outcome,v_code,v_at);
 RETURN QUERY SELECT 'applied'::text,jsonb_build_object('outcome',v_outcome,'code',v_code,'creditUnits',v_granted::text,'routeFixed',v_fixed)::text;
END $$;

-- The unknown-commit readback of one receipt's application. Outcomes: applied (with its
-- outcome and code), pending, not_found, invalid, denied.
CREATE FUNCTION morrow_billing.receipt_status(p_receipt_id text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE ap record;
BEGIN
 IF NOT morrow_billing.receipt_ingress() THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_receipt_id IS NULL OR p_receipt_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_billing.stripe_event_receipts x WHERE x.id=p_receipt_id) THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN;
 END IF;
 SELECT a.outcome,a.outcome_code INTO ap FROM morrow_billing.receipt_applications a WHERE a.receipt_id=p_receipt_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'pending'::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'applied'::text,jsonb_build_object('outcome',ap.outcome,'code',ap.outcome_code)::text;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S7 reads proacl), then the ownership transfer.
DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['workspace_associations()','cmd_checkout_open(text,text,text,text,text,text)','cmd_portal_open(text,text,text)',
  'stripe_op_begin(text)','stripe_op_settle(text,text,text,text)','receipt_object_valid(text,jsonb)',
  'stripe_receipt_record(text,text,text,text,text,text,text,text,text)','receipt_begin(text,text)','receipt_apply(text,text,text)',
  'receipt_status(text)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION morrow_billing.%s FROM PUBLIC',f);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION morrow_billing.receipt_object_valid(text,jsonb) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_billing.workspace_associations(),morrow_billing.cmd_checkout_open(text,text,text,text,text,text),
 morrow_billing.cmd_portal_open(text,text,text),morrow_billing.receipt_begin(text,text),morrow_billing.receipt_apply(text,text,text),
 morrow_billing.receipt_status(text) TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_billing.stripe_op_begin(text),morrow_billing.stripe_op_settle(text,text,text,text),
 morrow_billing.stripe_receipt_record(text,text,text,text,text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_billing TO morrow_work_command;
DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['workspace_associations()','cmd_checkout_open(text,text,text,text,text,text)','cmd_portal_open(text,text,text)',
  'stripe_op_begin(text)','stripe_op_settle(text,text,text,text)','stripe_receipt_record(text,text,text,text,text,text,text,text,text)',
  'receipt_begin(text,text)','receipt_apply(text,text,text)','receipt_status(text)'] LOOP
  EXECUTE format('ALTER FUNCTION morrow_billing.%s OWNER TO morrow_work_command',f);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA morrow_billing FROM morrow_work_command;
COMMIT;
