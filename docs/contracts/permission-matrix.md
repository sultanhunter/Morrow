# Permission matrix

Roles propose defaults; server grants determine authority. Owner is not a provider-permission bypass. View, propose, approve, execute, delegate and administration are separate grants. An agent installation intersects its owner, initiating principal, selected resource scope, current provider grants and mandate. A question or approval cannot repair a denied grant. Background work requires a current explicit mandate.

| Principal | Typical eligible path | Explicit boundary |
| --- | --- | --- |
| Small-brand owner | Granted store reads, drafting, eligible review and bounded execution | Provider access, budgets, field limits and exact review still apply |
| SEO specialist | Scoped product/public-page evidence, audits, copy/SEO drafts | No price, customer cases, refunds, ad spend or role administration by title |
| Creative specialist | Approved source images, briefs, bounded generation, contact sheets | Fidelity approval does not grant media publication |
| Ads specialist | Named ad accounts, aggregate reporting, draft/paused campaigns if granted | Audience and activation/spend authority remain separate |
| Support specialist | Assigned cases, scoped order facts, eligible reply workflows | Reply authority does not grant refunds or financial read access |
| Inventory operator | Named items/locations, reconciliation and authorized proposals | Absolute writes need configured source-of-truth authority |
| Finance specialist | Explicit cost fields and governed margin evidence | Costs do not become readable to unrelated teams via derived artifacts |
| Agent/coordinator | Intersection of installation and originating authority | Role name, tool availability, delegation and offline tokens cannot widen grants |
| Operator author/reviewer/publisher | Separate explicit first-party namespace permissions | Merchant ownership never grants release publishing or production customer access |

## Per-operation grants

| Capability | Eligible principal | Fields | Review |
| --- | --- | --- |
| workspace.goal.create | human_or_bounded_installation_with_explicit_capability_grant | objective, scope, successCriteria | Grant checks |
| workspace.task.create | human_or_bounded_installation_with_explicit_capability_grant | objective, scope, dependencies | Grant checks |
| workspace.task.assign | human_or_bounded_installation_with_explicit_capability_grant | assignee | Grant checks |
| workspace.task.delegate | human_or_bounded_installation_with_explicit_capability_grant | delegated resources, capabilities, budget, expiry | Grant checks |
| workspace.task.takeover | human_or_bounded_installation_with_explicit_capability_grant | execution owner, lease | Grant checks |
| workspace.task.pause | human_or_bounded_installation_with_explicit_capability_grant | dispatch state | Grant checks |
| workspace.task.resume | human_or_bounded_installation_with_explicit_capability_grant | dispatch state | Grant checks |
| workspace.task.cancel | human_or_bounded_installation_with_explicit_capability_grant | dispatch state | Grant checks |
| workspace.question.request | human_or_bounded_installation_with_explicit_capability_grant | question, respondent, answer schema | Grant checks |
| workspace.question.answer | human_or_bounded_installation_with_explicit_capability_grant | answer | Grant checks |
| workspace.artifact.read | human_or_bounded_installation_with_explicit_capability_grant | authorized content fields | Grant checks |
| workspace.artifact.edit | human_or_bounded_installation_with_explicit_capability_grant | draft content | Grant checks |
| workspace.comment.create | human_or_bounded_installation_with_explicit_capability_grant | comment body, anchor | Grant checks |
| workspace.knowledge.approve | eligible_human_reviewer_with_explicit_decision_grant | claims, policies, source references | Grant checks |
| workspace.knowledge.read | human_or_bounded_installation_with_explicit_capability_grant | approved knowledge fields | Grant checks |
| workspace.routine.configure | human_or_bounded_installation_with_explicit_capability_grant | trigger, timezone, overlap policy, mandate | Grant checks |
| workspace.routine.activate | human_or_bounded_installation_with_explicit_capability_grant | active schedule | Required |
| catalog.products.read | human_or_bounded_installation_with_explicit_capability_grant | title, description, SEO, variants, media, tags | Grant checks |
| catalog.audit.create | human_or_bounded_installation_with_explicit_capability_grant | catalog facts, approved claims | Grant checks |
| catalog.content.propose | human_or_bounded_installation_with_explicit_capability_grant | title, description, SEO title, SEO description | Grant checks |
| catalog.content.publish | human_or_bounded_installation_with_explicit_capability_grant | title, description, SEO title, SEO description | Required |
| catalog.variants.propose | human_or_bounded_installation_with_explicit_capability_grant | price, compare-at price, option values | Grant checks |
| catalog.variants.publish | human_or_bounded_installation_with_explicit_capability_grant | price, compare-at price, option values | Required |
| catalog.collection.propose | human_or_bounded_installation_with_explicit_capability_grant | membership, sort order | Grant checks |
| catalog.collection.publish | human_or_bounded_installation_with_explicit_capability_grant | membership, sort order | Required |
| catalog.channel.publish | human_or_bounded_installation_with_explicit_capability_grant | publication membership | Required |
| search.public.inspect | human_or_bounded_installation_with_explicit_capability_grant | public page text, metadata, crawl signals | Grant checks |
| search.performance.read | human_or_bounded_installation_with_explicit_capability_grant | clicks, impressions, CTR, position | Grant checks |
| search.audit.create | human_or_bounded_installation_with_explicit_capability_grant | public observations, authorized facts | Grant checks |
| search.improvements.propose | human_or_bounded_installation_with_explicit_capability_grant | product SEO, copy, content structure | Grant checks |
| search.citations.observe | human_or_bounded_installation_with_explicit_capability_grant | public query, answer, citation, observation metadata | Grant checks |
| search.results.report | human_or_bounded_installation_with_explicit_capability_grant | readback, observed indexing, referrals | Grant checks |
| creative.brief.create | human_or_bounded_installation_with_explicit_capability_grant | product fidelity constraints, style, outputs | Grant checks |
| creative.image.generate | human_or_bounded_installation_with_explicit_capability_grant | authorized input assets, generation parameters | Grant checks |
| creative.contact_sheet.create | human_or_bounded_installation_with_explicit_capability_grant | asset thumbnails, job provenance | Grant checks |
| creative.image.revise | human_or_bounded_installation_with_explicit_capability_grant | selected image, authorized changes | Grant checks |
| creative.image.approve | eligible_human_reviewer_with_explicit_decision_grant | review result, selected revision | Grant checks |
| creative.media.attach | human_or_bounded_installation_with_explicit_capability_grant | product media, alt text | Required |
| analytics.report.create | human_or_bounded_installation_with_explicit_capability_grant | aggregate metrics | Grant checks |
| analytics.anomaly.investigate | human_or_bounded_installation_with_explicit_capability_grant | aggregate metrics, authorized contributing facts | Grant checks |
| analytics.assortment.propose | human_or_bounded_installation_with_explicit_capability_grant | assortment suggestions | Grant checks |
| ads.accounts.read | human_or_bounded_installation_with_explicit_capability_grant | account identity, role, status | Grant checks |
| ads.performance.read | human_or_bounded_installation_with_explicit_capability_grant | spend, impressions, clicks, provider attribution | Grant checks |
| ads.campaign.propose | human_or_bounded_installation_with_explicit_capability_grant | campaign, ad set, creative, targeting, budget | Grant checks |
| ads.campaign.create_paused | human_or_bounded_installation_with_explicit_capability_grant | paused campaign, ad set, creative, ad | Required |
| ads.campaign.activate | human_or_bounded_installation_with_explicit_capability_grant | delivery status, explicit budget | Required |
| ads.budget.change | human_or_bounded_installation_with_explicit_capability_grant | daily or lifetime budget | Required |
| ads.campaign.pause | human_or_bounded_installation_with_explicit_capability_grant | delivery status | Required |
| ads.audience.select | human_or_bounded_installation_with_explicit_capability_grant | audience metadata excluding raw customer data | Grant checks |
| lifecycle.segment.read | human_or_bounded_installation_with_explicit_capability_grant | segment definition, count, consent coverage | Grant checks |
| lifecycle.campaign.propose | human_or_bounded_installation_with_explicit_capability_grant | subject, body, segment, schedule | Grant checks |
| lifecycle.campaign.create_draft | human_or_bounded_installation_with_explicit_capability_grant | unsent campaign fields | Required |
| lifecycle.campaign.send | human_or_bounded_installation_with_explicit_capability_grant | channel, recipients, content, schedule | Required |
| lifecycle.performance.read | human_or_bounded_installation_with_explicit_capability_grant | aggregate delivery, click, conversion data | Grant checks |
| support.case.read | human_or_bounded_installation_with_explicit_capability_grant | case transcript, permitted customer and order fields | Grant checks |
| support.reply.propose | human_or_bounded_installation_with_explicit_capability_grant | reply body, recipient, channel | Grant checks |
| support.reply.send | human_or_bounded_installation_with_explicit_capability_grant | recipient, channel, reply body | Required |
| support.case.escalate | human_or_bounded_installation_with_explicit_capability_grant | assignee, priority, escalation reason | Required |
| support.case.close | human_or_bounded_installation_with_explicit_capability_grant | case status | Required |
| orders.read | human_or_bounded_installation_with_explicit_capability_grant | allowed order, fulfillment, return fields | Grant checks |
| orders.exceptions.triage | human_or_bounded_installation_with_explicit_capability_grant | order exceptions, owner, proposed next action | Grant checks |
| orders.cancel | human_or_bounded_installation_with_explicit_capability_grant | cancellation fields and declared consequences | Required |
| orders.fulfillment.create | human_or_bounded_installation_with_explicit_capability_grant | fulfillment order, line quantities, tracking | Required |
| orders.fulfillment.tracking_update | human_or_bounded_installation_with_explicit_capability_grant | tracking company, number, URL | Required |
| orders.return.create | human_or_bounded_installation_with_explicit_capability_grant | return lines, quantities, reason | Required |
| orders.refund.create | human_or_bounded_installation_with_explicit_capability_grant | refund amount, currency, lines, shipping, restock consequences | Required |
| inventory.levels.read | human_or_bounded_installation_with_explicit_capability_grant | item, location, available quantity | Grant checks |
| inventory.risk.report | human_or_bounded_installation_with_explicit_capability_grant | stock coverage, forecast hypotheses | Grant checks |
| inventory.adjust.propose | human_or_bounded_installation_with_explicit_capability_grant | item, location, delta, reason | Grant checks |
| inventory.quantity.adjust | human_or_bounded_installation_with_explicit_capability_grant | quantity delta, location, reason | Required |
| inventory.quantity.set | human_or_bounded_installation_with_explicit_capability_grant | absolute quantity, location, compare quantity | Required |
| finance.costs.read | human_or_bounded_installation_with_explicit_capability_grant | unit cost, fees, shipping costs | Grant checks |
| finance.margin.report | human_or_bounded_installation_with_explicit_capability_grant | cost, refund, revenue, margin metrics | Grant checks |
| finance.reconciliation.propose | human_or_bounded_installation_with_explicit_capability_grant | discrepancies, source records, proposed investigation | Grant checks |
| storefront.ux.audit | human_or_bounded_installation_with_explicit_capability_grant | public pages, interaction observations | Grant checks |
| storefront.change.propose | human_or_bounded_installation_with_explicit_capability_grant | selected files or app-owned extension changes | Grant checks |
| storefront.extension.prepare | human_or_bounded_installation_with_explicit_capability_grant | app-owned extension source, configuration | Grant checks |
| storefront.extension.activate | human_or_bounded_installation_with_explicit_capability_grant | app-owned configuration | Required |
| storefront.theme.preview_write | human_or_bounded_installation_with_explicit_capability_grant | allowlisted theme files, non-live theme | Required |
| storefront.theme.publish | human_or_bounded_installation_with_explicit_capability_grant | live theme selection | Required |
| governance.membership.invite | human_or_bounded_installation_with_explicit_capability_grant | membership, proposed grants | Required |
| governance.grants.revise | eligible_human_reviewer_with_explicit_decision_grant | capability, resource, field, expiry constraints | Required |
| governance.membership.revoke | human_or_bounded_installation_with_explicit_capability_grant | membership, session revocation | Required |
| governance.connection.connect | human_or_bounded_installation_with_explicit_capability_grant | provider account, scope, vault reference | Required |
| governance.connection.disconnect | human_or_bounded_installation_with_explicit_capability_grant | connection state, credential revocation | Required |
| governance.approval.decide | eligible_human_reviewer_with_explicit_decision_grant | exact resources, fields, parameters, cost, expiry | Grant checks |
| governance.usage.read | human_or_bounded_installation_with_explicit_capability_grant | authorized usage and costs | Grant checks |
| governance.budget.revise | eligible_human_reviewer_with_explicit_decision_grant | task or cost-center budget | Required |
| governance.audit.export | human_or_bounded_installation_with_explicit_capability_grant | authorized audit records | Grant checks |
| governance.privacy.export | human_or_bounded_installation_with_explicit_capability_grant | verified subject data | Grant checks |
| governance.privacy.erase | human_or_bounded_installation_with_explicit_capability_grant | subject records and permitted derived content | Required |
| agents.listing.read | human_or_bounded_installation_with_explicit_capability_grant | public listing and authorized readiness fields | Grant checks |
| agents.builder.describe | human_or_bounded_installation_with_explicit_capability_grant | purpose, proposed skills, inputs, outputs, capabilities | Grant checks |
| agents.installation.stage | human_or_bounded_installation_with_explicit_capability_grant | release lockfile, configuration, proposed grants | Grant checks |
| agents.installation.sample | human_or_bounded_installation_with_explicit_capability_grant | qualified fixture, permitted context | Grant checks |
| agents.installation.activate | human_or_bounded_installation_with_explicit_capability_grant | pinned dependencies, configuration, grants | Required |
| agents.installation.upgrade | human_or_bounded_installation_with_explicit_capability_grant | release lockfile, compatible overlays | Required |
| agents.installation.disable | human_or_bounded_installation_with_explicit_capability_grant | dispatch and schedule state | Required |
| agents.installation.uninstall | human_or_bounded_installation_with_explicit_capability_grant | installation authority, routines | Required |
| agents.skill.research | operator_with_explicit_authoring_grant | approved research and fixture sources | Grant checks |
| agents.release.evaluate | operator_with_explicit_authoring_grant | candidate dependencies, approved fixtures | Grant checks |
| agents.release.publish | operator_with_explicit_authoring_grant | immutable digest, listing, publication state | Required |
| agents.release.revoke | operator_with_explicit_authoring_grant | release status, affected dispatch | Required |
