# Native WorkOS provider adapter preparation

Read-only preparation on16October2026 for a possible increment after the proposed85 self-logout work. This is not canonical86 authority, code, an activation permit or a request for credentials. The smallest useful slice is a source-owned fixed network implementation of84's existing private providerPort, qualified against synthetic transports before any native trial. Keep82's successful operator and consumed allowance unchanged.

## Verified public API facts

- AuthKit uses POST https://api.workos.com/user_management/authenticate for authorization-code exchange. Its reference lists client_id, grant_type=authorization_code and code; client_secret and code_verifier are optional parameters. It returns access/refresh tokens and user data. The reference alone does not establish every account's keyless eligibility;82's actual approved test establishes the selected staging case only. [AuthKit authentication reference](https://workos.com/docs/reference/authkit/authentication)
- The public signing key endpoint is GET https://api.workos.com/sso/jwks/{clientId}; the reference example includes RSA/RS256 key values and certificate metadata. [JWKS reference](https://workos.com/docs/reference/sso#get-jwks)
- GET /user_management/users/{userId}/sessions lists active sessions. The documented call uses an environment API key as a Bearer credential and supports after/before/limit/order pagination; its example contains session/user IDs, timestamps and authentication method. It is not a current-client-specific or perpetual-liveness guarantee. [Session reference](https://workos.com/docs/reference/authkit/session)
- WorkOS management API keys are private, environment-scoped credentials. The general reference warns that keys can perform broad API operations; it does not establish a sessions-read-only management-key capability for this account. User/organization API keys in AuthKit are a separate feature for authenticating customers to an application's APIs. Do not substitute them or claim narrowed management privilege without specific evidence. [API authentication](https://workos.com/docs/reference/api-authentication), [AuthKit API keys](https://workos.com/docs/authkit/api-keys)

The issuer examples are not completely consistent: the session-token reference shows a bare api.workos.com issuer, while the existing82 positive proof and unchanged72 profile use the client-specific issuer. WorkOS's own verification article warns that exact issuer values vary and documentation contains differing forms. Preserve the qualified exact Morrow profile; do not add bare/trailing-slash/custom-domain aliases or derive accepted configuration from an unverified incoming token. A different issuer/audience/application profile requires separate owned qualification. [Session-token reference](https://workos.com/docs/reference/authkit/session-tokens), [WorkOS verification guidance](https://workos.com/blog/verify-workos-access-tokens-in-your-own-api)

## Existing source facts

82's completeOnce native transport performs public JWKS first, then one keyless code POST, then up to four authenticated session GETs. Its native trial reported1/1/1 actual attempts, zero retries and verified_active_evidence, with separate exact-session cleanup. That result is historical only and no local family was issued.

84 calls exchange first, then readPublicKeyset, then invokes readSessionPage only inside its signature-verifying owning76 composition. That order is already canonical84. A new adapter must follow it;82 does not qualify this reordered end-to-end chain. If JWKS fails after exchange, do not repeat the consumed code POST.84 supplies the original one-use claim, fresh69 reservation, eligibility observations, at-most-once exchange latch and final77/M authority. Admission UUID is correlation, not an adapter-issued permission.

Do not import the82 permit/journal/operator into product identity. Those scripts have source/approval bindings and a one-use lifetime. In particular, their global used flag, GET/page counters and one-user trial selector cannot become shared application-lifetime counters that break concurrent independent logins. Preserve unchanged69/72/75/78/76/77/M/P and the native82 current-plan denial.

## Smallest proposed engineering seam

A new private source-owned factory would satisfy the exact existing frozen port methods; it would not add routes, identity verdicts, evidence handles, database writes, refresh/logout methods or a general HTTP client. Trusted config binds environment/application/client, exact callback and unchanged token profile. API origin and all endpoint templates are constants, never configurable URLs. The ordinary application entry remains unbound/denied.

| Method | Fixed wire contract and returned projection |
| --- | --- |
| exchange(inputJson, control) | Validate84's exact closed input and canonical verifier/admission UUID/client/callback. Send one JSON POST with only client_id,grant_type:"authorization_code",code,code_verifier. No Authorization/client_secret, cookie, arbitrary forwarding header or redirect_uri parameter; the AuthKit reference/82 wire uses those four fields, unlike WorkOS Connect's different token endpoint. Parse duplicate-free object JSON≤131072UTF8bytes, require access_token to be nonempty text≤16384characters under unchanged72 token rules, and return only {schemaVersion:1,accessToken} within84's32768byte projection cap. Drop refresh_token,user,oauth_tokens and all other provider content. Crypto/subject authority stays inside unchanged76/77. |
| readPublicKeyset(control) | One anonymous GET to the bound client JWKS URL. Bound response to65536bytes/16keys; encoding-check only the already observed certificate/thumbprint metadata, discard it, and preserve exact public RSA values for72. Never trust x5c as a separate PKI authority or accept private key fields. Return the existing profile-bound snapshot with observedAtMs at the fresh completed read and a conservative≤5minute expiry. This TTL is Morrow policy, not a vendor freshness promise. |
| readSessionPage(selectorJson, control) | Closed validated subject/after/limit100/orderasc selector to exactly one user-session GET with canonical optional after. Acquire the environment key only inside a trusted private borrow/use seam and put it only in this GET's Authorization header. Return bounded duplicate-free page text for unchanged78/75 parsing. One page≤131072bytes;78 owns the four-page/524288byte/ten-second/cursor/full-catalogue policy per observation, not an adapter-global mutable counter. |

The native constructor captures the runtime's native Fetch implementation and receives no fetch, URL, proxy, dispatcher or TLS override from HTTP/model input. A separate internal synthetic-test constructor may inject transport; it is not a production entrypoint. Use standards-based Fetch/WebCrypto so the selected Workers profile remains possible; qualify Node and Workers behavior rather than assuming equal redirect/body/cancellation semantics. SDK defaults/retries are unnecessary for three fixed calls. A Node native binding must retain82's rejection of disabled TLS validation, unexpected proxy/CA/preload overrides and ambient WORKOS credential fallback; Workers uses its separately qualified runtime bindings. Synthetic injection never enables a native path.

Every operation carries the original derived signal/deadline. Preserve25seconds total callback, exchange≤10seconds and composition≤10seconds. The unchanged observation lease expires at observation startedAt+5000ms, intersected with matched-session, token and keyset expiry; it never restarts after76 returns or credential disposal. A keyset per-call ceiling of5seconds is a proposed conservative bound within the outer deadline, not an existing vendor rule. Do not change84's limits or renew evidence to rescue a slow call. No cache, key-refresh retry, endpoint fallback, 429/5xx retry or code re-exchange in this smallest slice.

For every reply: redirect:error, credentials:omit, cache:no-store, exact final URL and redirected=false, status200 only, fixed JSON content type, bounded declared and streamed bytes, fatal UTF8 and strict duplicate-free parsing. Cancel/drain ownership on malformed, rejected, aborted and late replies; observe attempted/completed body disposal separately. A cancellation race is not proof that a sent POST had no effect. Fixed stage/status-class/count diagnostics only, never raw errors, URLs/code/verifier/header/body/JWT/key or refresh values.

## Credential boundary

Only session listing needs the broad environment key in this design. The broker's private fixed-purpose selector is bound to workos/environment/application/client and list-active-sessions, plus the current control; no caller chooses a secret reference or destination. Tests can borrow a synthetic marker and prove it appears only on the exact session GET. Current-source qualification can cover revoked/late/mismatched credential leases without acquiring any real key.

Hosted secret storage, production key lifecycle and an owned currently valid key are separate qualification steps. Key availability must not be inferred from a browser login or the old consumed trial. Dropping JavaScript references is not a claim of secure memory erasure. No new provider permit, generic capability system or durable dispatch journal is needed merely to implement and negatively test the wire adapter:84 already owns admission/one-use control. Production dispatch still requires a later explicitly qualified native binding.

## Meaningful qualification cases

- A separately generated RSA fixture through the actual84 bridge/real SQL produces the existing cookie and O/B behavior via the new synthetic wire adapter; posted client/code/S256 proof and returned projections are independently inspected. No success verdict is injected into76.
- Invalid configuration, foreign client/callback, extra input fields, unsupported verifier/admission/subject/cursor and denied/expired controls make zero transport calls. The broad key is absent from public JWKS and keyless POST.
- Redirect/foreign final URL, non200, Retry-After, HTML/JSON variants, invalid UTF8/duplicate keys, oversized declared/chunked/decompressed bodies, private JWKS material and malformed key metadata all hold without retry or onward calls.
- A late response/body/credential, abort or regressing clock never forwards a token/page or produces a late cookie; body-disposal attempts/completions remain separately measured. A timed-out POST remains potentially completed and never triggers a second POST.
- Concurrent independent bridge callbacks share no used/page/subject state; unchanged78 still enforces its own page/cursor/total limits. Catalogued missing/revoked/impersonated/ineligible-method sessions cannot create M authority.
- An internal fake Fetch qualifies fixed request construction and denial, not actual WorkOS DNS/TLS or owned account access. An optional isolated local HTTPS witness must use explicit synthetic CA trust and accurate fixture labeling; it cannot bypass fixed production URLs or be relabeled live-provider proof.

## Later actual input and remaining gates

No user input is needed for this adapter's preparation, implementation or negative qualification once its bounded canonical packet is saved. A later prepared live end-to-end trial genuinely needs current owned staging selectors/callback/profile, concrete temporary broad-key access scope, one fresh manual login and a controlled exact new-session cleanup plan. Decide that trial's limits only after reviewed code and exact-head CI; do not request it now or modify82 to reuse its consumed allowance.

Even a later successful native local trial will not qualify durable hosted encrypted custody, the four production Neon role pools/TLS/cancellation, hosted ingress and secret broker, actual browser cookie enforcement, SSO/SCIM/provisioning, P02 participants, or real Shopify proof/installation and its P08/P09 prerequisites. Keep these boundaries explicit; the native adapter is one missing transport, not merchant activation.

## Source bindings

- scripts/workos-authentication-operator-native.mjs SHA256 e9cf7d9038b7bf890dcd114b21dfe56e27eb7dac8267fba2c428db380c19a778
- scripts/workos-session-status-transport.mjs SHA256 f4edc4732e72127ae5819a5a9b8cf40171c7e1a5074d77136fc27e7099a8048e
- codex-archive-f89ad75:docs/evidence/P05.T01n/actual-staging-trial.json SHA256 7b3b95df108fb4ecf62dbb7c7643737c5e967c364f31992a6afa67e53b3271eb
- packages/identity/src/standalone-login.ts SHA256 12a5b7e9eeff006998d46f4119d87f86eb1d37b15ad271e16aae404bf370a6df
- packages/identity/src/workos-session-token.ts SHA256 198228864379483a4bdcd7fbba5982c429a20def7f189f66b2f1c8efb9ce7966
- packages/identity/src/workos-session-status.ts SHA256 babe11c985ed80ce0f64e0f4a7042c440f1c60c78483db6d70aeb835d145564e
- docs/packets/P05.T01p.md SHA256 6557f00627f4c92101890c615c564b1a26003f15cd558d2317f765a2c57b66e0
