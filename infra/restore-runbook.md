# Quarantined recovery

`npm run lab:restore` performs actual PostgreSQL17.11 pg_dump and transactional pg_restore into a new template0 database. It restores only namespaced synthetic fixtures, excluding old owners/ACLs. Its encrypted versioned-object fixture is process-local, not S3. Missing versions, accidental latest-version substitution and broken foreign keys are challenged. Deletion/revocation markers come from the newer synthetic source, outside the backup. The local DB rejects dispatch enablement and remains closed after successful integrity checks. Report times describe a tiny fixture, not production RTO/RPO or Aurora PITR.

For real recovery:

1. Declare the incident and choose an independently authorized recovery principal and target. Keep production source intact; do not restore old records over newer state to reverse an application deploy.
2. Quarantine the new database, object target and orchestration/queues before restoration. No task/service identity, provider credential access, outbound provider path or dispatcher may be active. An old database dispatch flag is not sufficient isolation.
3. Bind snapshot/PITR time and exact object-version manifest to their source account/environment/key IDs. Verify digests and current target permissions. Restore reviewed schemas and compatible binaries; do not replay old principals/grants unchecked.
4. Verify all foreign keys and every exact artifact revision/checksum. A missing revision holds recovery; never substitute the newest object. Account for migrations and retained histories separately.
5. Obtain a current, independently authoritative deletion/revocation journal and contiguous watermark extending past the backup through recovery. A journal restored from the same old backup cannot prove later erasures. Replay markers transactionally/idempotently, remove erased restored object versions, and retain the required backup-retention/deletion handling. This lab does not prove physical S3/backup erasure.
6. Invalidate old execution leases and hold restored work. Do not resurrect old approvals, customer permissions, spend reservations, subscriptions, credentials or provider connections. Later P05/P06/P08/P10/P11/P13 contracts supply the real reconciler implementations.
7. Reconcile newer workflow histories, unknown provider effects and financial liabilities against authoritative current systems before any retry. Work that cannot be reconciled remains held. Reopening must not retry an uncertain publication, message, refund or ad spend.
8. Require fresh authenticated human/automation authority, tenant/policy checks, new leases, cost approval, and a reviewed production reopening receipt. Successful local integrity alone cannot enable dispatch. Observe controlled recovery and qualify alerts/reconnection before resuming the service.

Current limits: no Aurora restore, real S3 version recovery, authenticated marker service, Temporal reconciliation, production restoration authority or reopening command. The local quarantine is a lab DB constraint plus an isolated no-network target. Future production quarantine needs actual service/IAM/network enforcement and account evidence. No RTO/RPO objective is claimed from the recorded milliseconds.

[PostgreSQL17 SQL dump and restore guidance](https://www.postgresql.org/docs/17/backup-dump.html).
