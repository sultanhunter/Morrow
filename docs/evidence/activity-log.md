# Activity log

One line per action under the owner's standing approval (ADR-0035 item 4): date (UTC), action, result, cost, and any unknown outcome until it is checked. Never the shop's domain, store data, customer data or secrets.

| Date | Action | Result | Cost | Unknown outcome |
| --- | --- | --- | --- | --- |
| 2026-10-24 | Deploys of `86cd8451` (#47), `c037d644` (#48), `c7a47b11` (#49) and, after #50, `13a9c5a8` (#52) by the deploy flag; no migrations | deployed | US$0 | none |
| 2026-10-24 | `staging:migrate` after PR #50 (`fa2fa1c9`): applied 0039 and 0040, ledger 40 | applied | US$0 | none |
| 2026-10-24 | Deploy `fa2fa1c9` (run 40039079008): gate 3 held for the migrate, rerun deployed | health ready, smoke passed (api and connector) | US$0 | none |
| 2026-10-24 | `staging:seed-platform -- --self-service` (E7 on the recorded WorkOS facts) | self-service enabled, terms revision 1 | US$0 | none |
| 2026-10-24 | `staging:migrate` after PR #53 (`ed5c70e5`): applied 0041 and 0042, ledger 42 | applied | US$0 | none |
| 2026-10-24 | Deploy `ed5c70e5` (run 40061118199): gate 3 held for the migrate, rerun deployed | deployed | US$0 | none |
| 2026-10-24 | `staging:migrate` after PR #51 (`7c161b13`): applied 0043, ledger 43 | applied | US$0 | none |
| 2026-10-24 | Deploy `7c161b13`: gate 3 held for the migrate, rerun deployed | deployed | US$0 | none |
| 2026-10-24 | `staging:migrate` after PR #54 (`57c057e5`): applied 0044 and 0045, ledger 45 | applied | US$0 | none |
| 2026-10-24 | Deploy `57c057e5` (run 40072967383): gate 3 held for the migrate, rerun deployed | deployed | US$0 | none |
| 2026-10-24 | Deploys of `9209636c` (#55), `9d3459e1` (#56), `aa84796b` (#59) and `57a68cd6` (#57) by the deploy flag; no migrations | deployed | US$0 | none |
| 2026-10-24 | Created the live-store Shopify app in the owner's Dev Dashboard organization, with its settings file kept outside the repository | created; no version released yet (the CLI's device login expired), not installed or registered | US$0 | none |
| 2026-10-24 | `staging:migrate` after PR #58 (`5541e430`): applied 0046, ledger 46 | applied | US$0 | none |
| 2026-10-24 | Deploy `5541e430` (run 40083171135): gate 3 held for the migrate, rerun deployed | deployed, health ready | US$0 | none |
| 2026-10-24 | Deploy `17b69fa4` (#61) by the deploy flag; no migrations | deployed | US$0 | none |
| 2026-10-25 | Deploy `500e87dc` (#62, sign-in clock fix and stage line; run 40134264879); `staging:migrate` applied nothing, ledger 46 | deployed, health ready | US$0 | none |
| 2026-10-25 | Released the live-store Shopify app's configuration as version v2 (scopes, callback, the three compliance webhooks; app/uninstalled and app/scopes_update left for shop-specific registration, which the legacy install flow requires) | released | US$0 | none |
| 2026-10-24 | `staging:shopify-app-register` for app key `morrow-live` from `500e87dc` (secret from the owner's 0600 file, sealed at version 1, file removed) | registered | US$0 | none |
| 2026-10-24 | `staging:test-entitlement` for the owner's workspace (approval `adr-0035.e13.2026-10-24.1`) | granted, 300 credits, 30 days | US$0 | none |
| 2026-10-24 | `staging:migrate` after PR #63 (`317c0a37`): applied 0047, ledger 47 | applied | US$0 | none |
| 2026-10-24 | Deploy `317c0a37` (run 40141526781): gate 3 held for the migrate, rerun deployed | deployed, health ready | US$0 | none |
| 2026-10-25 | Deploy `85cac200` (#65, Sunrise Inbox and activity log; run 40149064020); no migrations | deployed, health ready | US$0 | none |
| 2026-10-25 | Deploy `12615ad6` (#69, Shopify install fix: connector placed in aws:us-east-1, longer cold-start budgets, stage line; run 40150933599); no migrations | deployed, health ready, connector cf-placement remote-IAD | US$0 | none |
| 2026-10-25 | The owner installed the live-store app and linked the store to the owner workspace | linked; scopes read_products, write_products; token sealed in the broker vault | US$0 | none |
| 2026-10-25 | `staging:migrate` after PR #71 (`13e04367`): applied 0048 and 0049, ledger 49 | applied | US$0 | none |
| 2026-10-25 | Deploy `13e04367` (#71, shop-specific webhook subscriptions; run 40191910159): gate 3 held for the migrate, rerun deployed | deployed, health ready | US$0 | none |
| 2026-10-25 | `staging:migrate` after PR #67 (`3c08dc35`): applied 0050, ledger 50 | applied | US$0 | none |
| 2026-10-25 | Deploy `3c08dc35` (#67, Undo, apply history, approve several, product picker; run 40203082353): gate 3 held for the migrate, rerun deployed | deployed, health ready | US$0 | none |
| 2026-10-25 | `staging:migrate` after PR #70 (`ad4700a4`, ADR-0036 model defaults): applied 0051, ledger 51 | applied | US$0 | none |
| 2026-10-25 | Deploy `ad4700a4` (#70; run 40206288658): gate 3 held for the migrate, rerun deployed | deployed, health ready | US$0 | none |
| 2026-10-25 | `staging:put-secret -- ANTHROPIC_API_KEY` after PR #73 (`ce648d36`, model provider switched on) | refused `STAGING_FILE_FORMAT`: the owner file is not a Console API key; nothing placed | US$0 | none |
| 2026-10-25 | Deploy `ce648d36` (#73; run 40212557417): gate 6 held it for the missing `ANTHROPIC_API_KEY`, nothing uploaded; one rerun held the same | held; staging keeps `ad4700a4` | US$0 | none |
| 2026-10-26 | `staging:migrate` after PR #77 (`fd45f7cc`; includes #68 shop knowledge): applied 0052, ledger 52 | applied | US$0 | none |
| 2026-10-26 | `staging:put-secret -- ANTHROPIC_API_KEY` from `fd45f7cc` (the owner's identity-backed key, scoped to the Morrow workspace; PR #77 admits its shape) | placed, one broker version | US$0 | none |
| 2026-10-26 | Deploy `fd45f7cc` (run 40230234530): gate 3 held for the migrate, rerun deployed with the model provider on | deployed, health ready; broker secrets: none missing, none extra | US$0 | none |
| 2026-10-26 | Deploy `7d726330` (#74, connector cron in a Durable Object; run 40235644005) | deployed, health ready; connector scheduled jobs complete in about 1 s; shop webhook registration status registered | US$0 | none |
| 2026-10-26 | `staging:migrate` after PR #66 (`c41b79ee`, connection health): applied 0053 and 0054, ledger 54 | applied | US$0 | none |
| 2026-10-26 | Deploy `c41b79ee` (#66; run 40282609164): gate 3 held for the migrate, rerun deployed; clean-up switch stays off | deployed, health ready | US$0 | none |
| 2026-10-26 | `staging:migrate` after PR #80 (`43cc5489`, test-credit renewal): applied 0055, ledger 55 | applied | US$0 | none |
| 2026-10-26 | Deploy `43cc5489` (#80; run 40292979102): gate 3 held for the migrate, rerun deployed | deployed, health ready | US$0 | none |
