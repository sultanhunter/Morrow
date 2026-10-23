# Permission matrix

Roles propose defaults; server grants determine authority. Owner is not a provider-permission bypass. View, propose, approve, execute, delegate and administration are separate grants. Executor classes (contract v1.1, ADR-0005): agents get no verb on a human_only capability except propose, and only where a proposal path exists (a kill switch or a reviewed capability); agent_after_approval needs an exact approval; agent_direct_write and agent_direct_read keep the existing bounded agent authority. Kill switches act without a second approver. An agent installation intersects its owner, initiating principal, selected resource scope, current provider grants and mandate. A question or approval cannot repair a denied grant. Background work requires a current explicit mandate.

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

| Capability | Eligible principal | Fields | Review | Executor | Kill switch |
| --- | --- | --- | --- | --- | --- |
| workspace.goal.create | human_or_bounded_installation_with_explicit_capability_grant | objective, scope, successCriteria | Grant checks | agent_direct_write | No |
| workspace.task.create | human_or_bounded_installation_with_explicit_capability_grant | objective, scope, dependencies | Grant checks | agent_direct_write | No |
| workspace.task.assign | human_or_bounded_installation_with_explicit_capability_grant | assignee | Grant checks | agent_direct_write | No |
| workspace.task.delegate | human_or_bounded_installation_with_explicit_capability_grant | delegated resources, capabilities, budget, expiry | Grant checks | agent_direct_write | No |
| workspace.task.takeover | human_or_bounded_installation_with_explicit_capability_grant | execution owner, lease | Grant checks | human_only | No |
| workspace.task.pause | human_or_bounded_installation_with_explicit_capability_grant | dispatch state | Grant checks | agent_direct_write | No |
| workspace.task.resume | human_or_bounded_installation_with_explicit_capability_grant | dispatch state | Grant checks | agent_direct_write | No |
| workspace.task.cancel | human_or_bounded_installation_with_explicit_capability_grant | dispatch state | Grant checks | agent_direct_write | No |
| workspace.question.request | human_or_bounded_installation_with_explicit_capability_grant | question, respondent, answer schema | Grant checks | agent_direct_write | No |
| workspace.question.answer | human_or_bounded_installation_with_explicit_capability_grant | answer | Grant checks | agent_direct_write | No |
| workspace.artifact.read | human_or_bounded_installation_with_explicit_capability_grant | authorized content fields | Grant checks | agent_direct_read | No |
| workspace.artifact.edit | human_or_bounded_installation_with_explicit_capability_grant | draft content | Grant checks | agent_direct_write | No |
| workspace.comment.create | human_or_bounded_installation_with_explicit_capability_grant | comment body, anchor | Grant checks | agent_direct_write | No |
| workspace.knowledge.approve | eligible_human_reviewer_with_explicit_decision_grant | claims, policies, source references | Grant checks | human_only | No |
| workspace.knowledge.read | human_or_bounded_installation_with_explicit_capability_grant | approved knowledge fields | Grant checks | agent_direct_read | No |
| workspace.routine.configure | human_or_bounded_installation_with_explicit_capability_grant | trigger, timezone, overlap policy, mandate, goal record | Grant checks | agent_direct_write | No |
| workspace.routine.activate | human_or_bounded_installation_with_explicit_capability_grant | active schedule | Required | human_only | No |
| workspace.conversation.create | human_or_bounded_installation_with_explicit_capability_grant | store, subject | Grant checks | human_only | No |
| workspace.conversation.post | human_or_bounded_installation_with_explicit_capability_grant | parts, reply, sources | Grant checks | agent_direct_write | No |
| workspace.project.create | human_or_bounded_installation_with_explicit_capability_grant | goal, title, tabs | Grant checks | human_only | No |
| workspace.project.revise | human_or_bounded_installation_with_explicit_capability_grant | title, tabs | Grant checks | agent_direct_write | No |
| workspace.project.pin | human_or_bounded_installation_with_explicit_capability_grant | pin, order | Grant checks | human_only | No |
| workspace.inbox.read | human_or_bounded_installation_with_explicit_capability_grant | kind, subject, decision state, read state | Grant checks | human_only | No |
| workspace.inbox.mark | human_or_bounded_installation_with_explicit_capability_grant | read state | Grant checks | human_only | No |
| workspace.goal.revise | human_or_bounded_installation_with_explicit_capability_grant | objective, end date, targets, check questions, assistant | Grant checks | human_only | No |
| workspace.goal.measure.record | human_or_bounded_installation_with_explicit_capability_grant | goal, product row, assistant, answers | Grant checks | human_only | No |
| catalog.products.read | human_or_bounded_installation_with_explicit_capability_grant | title, description, SEO, variants, media, tags | Grant checks | agent_direct_read | No |
| catalog.audit.create | human_or_bounded_installation_with_explicit_capability_grant | catalog facts, approved claims | Grant checks | agent_direct_write | No |
| catalog.content.propose | human_or_bounded_installation_with_explicit_capability_grant | title, description, SEO title, SEO description, tags | Grant checks | agent_direct_write | No |
| catalog.content.publish | human_or_bounded_installation_with_explicit_capability_grant | title, description, SEO title, SEO description, tags | Required | agent_after_approval | No |
| catalog.variants.propose | human_or_bounded_installation_with_explicit_capability_grant | price, compare-at price, option values | Grant checks | agent_direct_write | No |
| catalog.variants.publish | human_or_bounded_installation_with_explicit_capability_grant | price, compare-at price, option values | Required | agent_after_approval | No |
| catalog.collection.propose | human_or_bounded_installation_with_explicit_capability_grant | membership, sort order | Grant checks | agent_direct_write | No |
| catalog.collection.publish | human_or_bounded_installation_with_explicit_capability_grant | membership, sort order | Required | agent_after_approval | No |
| catalog.channel.publish | human_or_bounded_installation_with_explicit_capability_grant | publication membership | Required | agent_after_approval | No |
| search.public.inspect | human_or_bounded_installation_with_explicit_capability_grant | public page text, metadata, crawl signals | Grant checks | agent_direct_read | No |
| search.performance.read | human_or_bounded_installation_with_explicit_capability_grant | clicks, impressions, CTR, position | Grant checks | agent_direct_read | No |
| search.audit.create | human_or_bounded_installation_with_explicit_capability_grant | public observations, authorized facts | Grant checks | agent_direct_write | No |
| search.improvements.propose | human_or_bounded_installation_with_explicit_capability_grant | product SEO, copy, content structure | Grant checks | agent_direct_write | No |
| search.citations.observe | human_or_bounded_installation_with_explicit_capability_grant | public query, answer, citation, observation metadata | Grant checks | agent_direct_read | No |
| search.results.report | human_or_bounded_installation_with_explicit_capability_grant | readback, observed indexing, referrals | Grant checks | agent_direct_write | No |
| creative.brief.create | human_or_bounded_installation_with_explicit_capability_grant | product fidelity constraints, style, outputs | Grant checks | agent_direct_write | No |
| creative.image.generate | human_or_bounded_installation_with_explicit_capability_grant | authorized input assets, generation parameters | Grant checks | agent_direct_write | No |
| creative.contact_sheet.create | human_or_bounded_installation_with_explicit_capability_grant | asset thumbnails, job provenance | Grant checks | agent_direct_write | No |
| creative.image.revise | human_or_bounded_installation_with_explicit_capability_grant | selected image, authorized changes | Grant checks | agent_direct_write | No |
| creative.image.approve | eligible_human_reviewer_with_explicit_decision_grant | review result, selected revision | Grant checks | human_only | No |
| creative.media.attach | human_or_bounded_installation_with_explicit_capability_grant | product media, alt text | Required | agent_after_approval | No |
| analytics.report.create | human_or_bounded_installation_with_explicit_capability_grant | aggregate metrics | Grant checks | agent_direct_write | No |
| analytics.anomaly.investigate | human_or_bounded_installation_with_explicit_capability_grant | aggregate metrics, authorized contributing facts | Grant checks | agent_direct_write | No |
| analytics.assortment.propose | human_or_bounded_installation_with_explicit_capability_grant | assortment suggestions | Grant checks | agent_direct_write | No |
| ads.accounts.read | human_or_bounded_installation_with_explicit_capability_grant | account identity, role, status | Grant checks | agent_direct_read | No |
| ads.performance.read | human_or_bounded_installation_with_explicit_capability_grant | spend, impressions, clicks, provider attribution | Grant checks | agent_direct_read | No |
| ads.campaign.propose | human_or_bounded_installation_with_explicit_capability_grant | campaign, ad set, creative, targeting, budget | Grant checks | agent_direct_write | No |
| ads.campaign.create_paused | human_or_bounded_installation_with_explicit_capability_grant | paused campaign, ad set, creative, ad | Required | agent_after_approval | No |
| ads.campaign.activate | human_or_bounded_installation_with_explicit_capability_grant | delivery status, explicit budget | Required | agent_after_approval | No |
| ads.budget.change | human_or_bounded_installation_with_explicit_capability_grant | daily or lifetime budget | Required | agent_after_approval | No |
| ads.campaign.pause | human_or_bounded_installation_with_explicit_capability_grant | delivery status | Grant checks | human_only | Yes |
| ads.audience.select | human_or_bounded_installation_with_explicit_capability_grant | audience metadata excluding raw customer data | Grant checks | agent_direct_read | No |
| lifecycle.segment.read | human_or_bounded_installation_with_explicit_capability_grant | segment definition, count, consent coverage | Grant checks | agent_direct_read | No |
| lifecycle.campaign.propose | human_or_bounded_installation_with_explicit_capability_grant | subject, body, segment, schedule | Grant checks | agent_direct_write | No |
| lifecycle.campaign.create_draft | human_or_bounded_installation_with_explicit_capability_grant | unsent campaign fields | Required | agent_after_approval | No |
| lifecycle.campaign.send | human_or_bounded_installation_with_explicit_capability_grant | channel, recipients, content, schedule | Required | agent_after_approval | No |
| lifecycle.performance.read | human_or_bounded_installation_with_explicit_capability_grant | aggregate delivery, click, conversion data | Grant checks | agent_direct_read | No |
| support.case.read | human_or_bounded_installation_with_explicit_capability_grant | case transcript, permitted customer and order fields | Grant checks | agent_direct_read | No |
| support.reply.propose | human_or_bounded_installation_with_explicit_capability_grant | reply body, recipient, channel | Grant checks | agent_direct_write | No |
| support.reply.send | human_or_bounded_installation_with_explicit_capability_grant | recipient, channel, reply body | Required | agent_after_approval | No |
| support.case.escalate | human_or_bounded_installation_with_explicit_capability_grant | assignee, priority, escalation reason | Required | agent_after_approval | No |
| support.case.close | human_or_bounded_installation_with_explicit_capability_grant | case status | Required | agent_after_approval | No |
| orders.read | human_or_bounded_installation_with_explicit_capability_grant | allowed order, fulfillment, return fields | Grant checks | agent_direct_read | No |
| orders.exceptions.triage | human_or_bounded_installation_with_explicit_capability_grant | order exceptions, owner, proposed next action | Grant checks | agent_direct_write | No |
| orders.cancel | human_or_bounded_installation_with_explicit_capability_grant | cancellation fields and declared consequences | Required | agent_after_approval | No |
| orders.fulfillment.create | human_or_bounded_installation_with_explicit_capability_grant | fulfillment order, line quantities, tracking | Required | agent_after_approval | No |
| orders.fulfillment.tracking_update | human_or_bounded_installation_with_explicit_capability_grant | tracking company, number, URL | Required | agent_after_approval | No |
| orders.return.create | human_or_bounded_installation_with_explicit_capability_grant | return lines, quantities, reason | Required | agent_after_approval | No |
| orders.refund.create | human_or_bounded_installation_with_explicit_capability_grant | refund amount, currency, lines, shipping, restock consequences | Required | agent_after_approval | No |
| inventory.levels.read | human_or_bounded_installation_with_explicit_capability_grant | item, location, available quantity | Grant checks | agent_direct_read | No |
| inventory.risk.report | human_or_bounded_installation_with_explicit_capability_grant | stock coverage, forecast hypotheses | Grant checks | agent_direct_write | No |
| inventory.adjust.propose | human_or_bounded_installation_with_explicit_capability_grant | item, location, delta, reason | Grant checks | agent_direct_write | No |
| inventory.quantity.adjust | human_or_bounded_installation_with_explicit_capability_grant | quantity delta, location, reason | Required | agent_after_approval | No |
| inventory.quantity.set | human_or_bounded_installation_with_explicit_capability_grant | absolute quantity, location, compare quantity | Required | agent_after_approval | No |
| finance.costs.read | human_or_bounded_installation_with_explicit_capability_grant | unit cost, fees, shipping costs | Grant checks | agent_direct_read | No |
| finance.margin.report | human_or_bounded_installation_with_explicit_capability_grant | cost, refund, revenue, margin metrics | Grant checks | agent_direct_write | No |
| finance.reconciliation.propose | human_or_bounded_installation_with_explicit_capability_grant | discrepancies, source records, proposed investigation | Grant checks | agent_direct_write | No |
| storefront.ux.audit | human_or_bounded_installation_with_explicit_capability_grant | public pages, interaction observations | Grant checks | agent_direct_read | No |
| storefront.change.propose | human_or_bounded_installation_with_explicit_capability_grant | selected files or app-owned extension changes | Grant checks | agent_direct_write | No |
| storefront.extension.prepare | human_or_bounded_installation_with_explicit_capability_grant | app-owned extension source, configuration | Grant checks | agent_direct_write | No |
| storefront.extension.activate | human_or_bounded_installation_with_explicit_capability_grant | app-owned configuration | Required | agent_after_approval | No |
| storefront.theme.preview_write | human_or_bounded_installation_with_explicit_capability_grant | allowlisted theme files, non-live theme | Required | agent_after_approval | No |
| storefront.theme.publish | human_or_bounded_installation_with_explicit_capability_grant | live theme selection | Required | agent_after_approval | No |
| governance.membership.invite | human_or_bounded_installation_with_explicit_capability_grant | membership, proposed grants | Required | human_only | No |
| governance.grants.revise | eligible_human_reviewer_with_explicit_decision_grant | capability, resource, field, expiry constraints | Required | human_only | No |
| governance.membership.revoke | human_or_bounded_installation_with_explicit_capability_grant | membership, session revocation | Grant checks | human_only | Yes |
| governance.connection.connect | human_or_bounded_installation_with_explicit_capability_grant | provider account, scope, vault reference | Required | human_only | No |
| governance.connection.disconnect | human_or_bounded_installation_with_explicit_capability_grant | connection state, credential revocation | Grant checks | human_only | Yes |
| governance.approval.decide | eligible_human_reviewer_with_explicit_decision_grant | exact resources, fields, parameters, cost, expiry | Grant checks | human_only | No |
| governance.approval.preview | eligible_human_reviewer_with_explicit_decision_grant | exact resources, fields, parameters, cost, expiry | Grant checks | human_only | No |
| governance.review_policy.revise | human_or_bounded_installation_with_explicit_capability_grant | review rules, quorum, expiry, self-approval | Required | human_only | No |
| governance.usage.read | human_or_bounded_installation_with_explicit_capability_grant | authorized usage and costs | Grant checks | agent_direct_read | No |
| governance.budget.revise | eligible_human_reviewer_with_explicit_decision_grant | task or cost-center budget | Required | human_only | No |
| governance.audit.export | human_or_bounded_installation_with_explicit_capability_grant | authorized audit records | Grant checks | human_only | No |
| governance.privacy.export | human_or_bounded_installation_with_explicit_capability_grant | verified subject data | Grant checks | human_only | No |
| governance.privacy.erase | human_or_bounded_installation_with_explicit_capability_grant | subject records and permitted derived content | Required | human_only | No |
| governance.access.request | human_or_bounded_installation_with_explicit_capability_grant | capability, resource, field, reason | Grant checks | human_only | No |
| governance.billing.manage | human_or_bounded_installation_with_explicit_capability_grant | purchase action, plan price | Grant checks | human_only | No |
| governance.model_default.revise | human_or_bounded_installation_with_explicit_capability_grant | default model, default effort, member credit ceiling | Grant checks | human_only | No |
| agents.listing.read | human_or_bounded_installation_with_explicit_capability_grant | public listing and authorized readiness fields | Grant checks | agent_direct_read | No |
| agents.builder.describe | human_or_bounded_installation_with_explicit_capability_grant | purpose, proposed skills, inputs, outputs, capabilities | Grant checks | agent_direct_write | No |
| agents.installation.stage | human_or_bounded_installation_with_explicit_capability_grant | release lockfile, configuration, proposed grants | Grant checks | agent_direct_write | No |
| agents.installation.sample | human_or_bounded_installation_with_explicit_capability_grant | qualified fixture, permitted context | Grant checks | agent_direct_write | No |
| agents.installation.activate | human_or_bounded_installation_with_explicit_capability_grant | pinned dependencies, configuration, grants | Required | human_only | No |
| agents.installation.upgrade | human_or_bounded_installation_with_explicit_capability_grant | release lockfile, compatible overlays | Required | human_only | No |
| agents.installation.disable | human_or_bounded_installation_with_explicit_capability_grant | dispatch and schedule state | Grant checks | human_only | Yes |
| agents.installation.uninstall | human_or_bounded_installation_with_explicit_capability_grant | installation authority, routines | Required | human_only | No |
| agents.skill.research | operator_with_explicit_authoring_grant | approved research and fixture sources | Grant checks | agent_direct_write | No |
| agents.release.evaluate | operator_with_explicit_authoring_grant | candidate dependencies, approved fixtures | Grant checks | agent_direct_write | No |
| agents.release.publish | operator_with_explicit_authoring_grant | immutable digest, listing, publication state | Required | human_only | No |
| agents.release.revoke | operator_with_explicit_authoring_grant | release status, affected dispatch | Grant checks | human_only | Yes |
