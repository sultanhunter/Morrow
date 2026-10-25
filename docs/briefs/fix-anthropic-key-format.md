# Admit Anthropic's identity-backed API keys

- Status: built, 2026-10-26. Branch `claude/fix-anthropic-key-format`, one PR, cut from `410cabb3`.
- Change class: routine (ADR-0002). A fix to the shape check of a credential the broker already holds under ADR-0022 item 7; no change to custody, provider, authority or money.

## Goal

The owner's Anthropic key can be placed and used, so the model-provider switch (model-provider-on) goes live.

## What went wrong

`npm run staging:put-secret -- ANTHROPIC_API_KEY` refused the owner's file twice with `STAGING_FILE_FORMAT`. The tool, and the broker behind it, admitted only `sk-ant-api03-` plus 80 to 200 characters. That is the legacy workspace key. The Claude Console now creates personal and service-account keys by default. Its documentation says only that a key "starts with `sk-ant-`" ([Get your Claude API key](https://platform.claude.com/docs/en/get-api-key)), and calls workspace keys legacy ([Authentication, key types](https://platform.claude.com/docs/en/manage-claude/authentication#key-types)).

A check of both of the owner's files printed only booleans and lengths, never a key character. Both have the same shape: `sk-ant-`, a three-lowercase-letter label that is the same in both, a dash, then 95 characters. The two keys differ, so the label is a key-type label, not random.

## Scope

- `packages/identity/src/broker-protocol.ts` `anthropicKeyPattern` and `scripts/staging-files.mjs` `anthropicKeyFormat`, which a test keeps byte-equal: `^sk-ant-(?:api03|[a-z]{3})-[A-Za-z0-9_-]{80,200}$`.
- Admin keys (`sk-ant-admin01-`), OAuth tokens (`sk-ant-oat01-`) and session keys carry digits in their label, so they still never match. A two- or four-letter label, an upper-case label, a short secret or a trailing newline is refused.
- `infra/rotation-runbook.md`: the key must be scoped to the Morrow workspace, because the broker sends no `anthropic-workspace-id` header and an unscoped identity-backed key fails every call with a 400. A service-account key is preferred, and a personal key of the owner works.

## Interfaces touched

None. The broker still sends the key as `x-api-key`, which Anthropic documents as a supported legacy header. Nothing else in the request changes.

## Security notes

- The key stays readable only by the broker. The tools read the owner file in-process and never print it. Diagnosing this printed no key character.
- The pattern stays closed. It only admits a second label shape, and every refusal case of the old pattern is still refused.
- If the key is not scoped to the workspace, every model call fails closed with a 400 that the adapter's closed outcome mapping already handles. No call goes to another workspace.

## Test checklist

- [x] `tests/staging-secrets.test.mjs`: the tool admits a legacy key and an identity-backed key (whose secret holds `-` and `_`), and refuses admin, OAuth and session labels, two- and four-letter labels, an upper-case label, a short secret and a trailing newline; the drift test keeps the two patterns equal.
- [x] `tests/broker.test.mjs`: the broker builds its model capability from an identity-backed key, and none from an admin key or an OAuth token.
- [ ] Hosted `foundation` green; then `staging:put-secret -- ANTHROPIC_API_KEY`, the held deploy rerun, and the broker's model capability live.
