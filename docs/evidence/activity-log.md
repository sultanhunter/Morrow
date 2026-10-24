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
