// ADR-0020 item 4 and P04.T01j D5: the application preflight of an identity executor's
// own role, the `role_member` column of each adapter's role query. It is true, and the
// adapter refuses the transaction with INVALID_INTERNAL_ROLE, when the executor is a
// member of any role, when more than one membership row names it, or when the one row
// that names it is not the PostgreSQL 16+ CREATE ROLE row: grantor oid 10 (the bootstrap
// superuser), admin true, inherit false, set false, with a member that is neither a
// Morrow role nor a superuser. A local superuser setup has no row at all.
// This is defence in depth only. The executor cannot read the recorded migration
// administrator, so the database guards (morrow_identity.executor_memberships_closed)
// stay the authority; this check refuses a second administrator only by count and every
// other non-creation shape by its form. The pg-wire oracles keep an independent literal
// copy of this text.
export const executorRoleMemberSql =
  "(EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) OR (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid)>1 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid=m.member WHERE m.roleid=r.oid AND NOT (m.grantor=10 AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option AND u.rolname NOT LIKE 'morrow\\_%' AND NOT u.rolsuper))) AS role_member";
