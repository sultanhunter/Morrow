# ADR-0038 Cloudflare Durable Objects in the stack: one object that runs the connector's cron beside the database

- Status: Accepted 2026-10-25 (the owner, OD-2026-10-25-4; confirmed in so many words, OD-2026-10-25-5)
- Date: 2026-10-25
- Supersedes: nothing.
- Amends: the settled stack line in CLAUDE.md ("Stack: … Cloudflare Workers, Workflows, Queues and R2 …") and `docs/plan/build-plan.md`'s stack lines (its Stack bullet and the selected-stack paragraph), which gain Durable Objects within item 1's limits. The wording of those lines changes in its own follow-up (see Approval).
- Does not change: ADR-0007 and ADR-0022 item 7 (raw credentials stay in the broker); ADR-0019 and ADR-0035 (one environment; the api and the connector are the only public Workers); ADR-0031 (the object stores nothing); the M2 brief's 2026-10-21 decision on the ingress semaphore (still declined; another Durable Object use needs its own record); every security invariant.
- Brief: `docs/briefs/fix-connector-cron-latency.md` (the diagnosis, the change and its tests).

## In plain words

The connector's five-minute check runs far from the database, so every step runs out of time and the shop's webhooks never get registered. Moving the check into one Cloudflare Durable Object, created next to the database, fixes it. A Durable Object is a small built-in part of Cloudflare Workers, but it is not in Morrow's agreed stack, so adding it needs this record.

## Context

- The settled stack names Cloudflare Workers, Workflows, Queues and R2. ADR-0002, with ADR-0021 item 5, makes provider selection, deployment boundaries and creating provider resources material. The M2 brief already called a Durable Object "a provider selection". A Durable Object namespace is a new Cloudflare resource type, created by a Worker migration.
- The first connector cron after PR #71's deploy (2026-10-25, 12:41 UTC) failed all four of its steps: the webhook inbox re-apply, the token destruction, the privacy count and the shop-specific webhook registration. The owner's store still has no `app/uninstalled` or `app/scopes_update` subscription.
- The cause is distance. Cloudflare's placement moves only fetch handlers, so `scheduled()` runs on whatever machine Cloudflare picks, and the broker RPCs it makes run there too. Each database transaction is about 13 sequential round trips to Neon in us-east-1 against a 3000 ms budget, which every transaction misses from a machine more than about 230 ms away.
- The fix was built and tested on a branch before this record was accepted, so the owner could decide with the evidence in hand.

## Decision

1. **Scope.** Cloudflare Durable Objects join the stack only as SQLite-backed classes of an existing Worker, reachable only through that Worker's own namespace binding. There is exactly one: `ConnectorCron` in the connector Worker, bound as `CONNECTOR_CRON` in every environment and created by the migration `{tag: "v1", new_sqlite_classes: ["ConnectorCron"]}`. Another class, another Worker, stored data, alarms or a public address each need a new record.
2. **What the object does.** One argument-free RPC method, `redrive()`, runs the connector's existing re-drives with the Worker's own bindings and answers one closed outcome (`ran`, `unbound` or `busy`). It has no `fetch`, route, hostname or secret binding, and its SQLite storage stays empty. Its name is a constant. Its location hint is a constant that `edge:check` ties to `infra/environments/staging.json`'s Neon region (`EDGE_CONNECTOR_CRON_LOCATION`). A region without a hint Cloudflare honours (South America, Africa, the Middle East) fails that check, so a database move there needs a reviewed decision.
3. **Enforcement in code.** `edge:check` pins the binding and the migration exactly (`EDGE_CONNECTOR_DURABLE_OBJECTS`, `EDGE_CONNECTOR_MIGRATIONS`) and refuses either on every other Worker (`EDGE_UNEXPECTED_BINDING_*`). A connector without the binding runs nothing and logs `CRON_UNBOUND` (default deny).
4. **The way back.** Cloudflare does not roll a version back across a Durable Object migration. The way back is a forward deploy: `scheduled()` running the re-drives itself again, with the class left unused or removed by a `deleted_classes` migration `v2`. That forward change is routine under this record.
5. **Cost.** About 288 object requests a day per deployed environment and a few seconds of duration per run, with no storage. No purchase or plan change; within the existing caps.

## Security invariants touched

- **Default entry denies:** a missing or malformed binding runs nothing (`tests/connector-cron.test.mjs`, `lab:edge-workers`).
- **Credential custody:** no credential moves. The connector still binds no secret, leases its database login per transaction from the broker and calls the same `ConnectorBroker` entrypoint.
- **Tenant isolation:** the same connector login, roles and RLS as before.
- **Unknown outcomes:** unchanged. The inbox applier and the token destruction are idempotent and re-driven by id; the sync lists before it creates. A deploy that resets a running object cuts a run as an evicted cron would, and the next run re-drives.
- **Deployment boundary:** one new resource type inside the existing connector Worker, with no new public surface (`tests/edge-config.test.mjs` "fix-connector-cron-latency: …").

## Consequences

- The connector's cron runs near Neon whatever machine Cloudflare picks for `scheduled()`, and the existing 3 s budgets hold.
- The connector's deploy now carries a Durable Object migration, so version rollbacks across it are refused by Cloudflare (item 4).
- The orchestrator's cron, queue and workflow handlers have the same latent distance problem. They are harmless while their switches are off; the brief that turns them on chooses this pattern under a new record, or explicit budgets.

## Alternatives considered

- **Longer cron budgets (the routine stopgap):** about 8–10 s for the connector's id reads and applies, a scaled-up vault budget for the sync, and a cron budget for the broker's token destruction, which needs an RPC parameter. It works from anywhere, but the cron stays exposed to wherever Cloudflare runs it, and more surfaces change. It needs no record.
- **Placement for the cron:** Cloudflare's placement does not apply to scheduled handlers.
- **Moving the cron to the orchestrator:** its scheduled handler has the same problem.

## Owner question

As put to the owner; answered on 2026-10-25 (see Approval).

> The connector's five-minute check runs far from the database, so the shop webhooks never get registered. The fix moves the check into a Cloudflare Durable Object, a small built-in Cloudflare feature, created near the database inside the same connector Worker. It costs nothing at this size, stores nothing and adds no public address. Durable Objects are not in Morrow's agreed stack, so adding them needs a short decision record. What should we do?
>
> - **Approve ADR-0038 (Recommended).** Durable Objects join the stack for this one connector object only, under the limits in its item 1. The fix merges and deploys after that.
> - **No new Cloudflare feature.** Use the stopgap instead: longer time limits on the cron path only. ADR-0038 is withdrawn.

With this record accepted, CLAUDE.md's stack line is to read: "Stack: TypeScript/React; Cloudflare Workers (with SQLite-backed Durable Objects under ADR-0038), Workflows, Queues and R2; Neon PostgreSQL; E2B isolated execution; WorkOS identity. Morrow owns all authorization."

## Approval

The owner's statement in chat, verbatim, on 2026-10-25, in answer to the lead's message that listed the eight questions of the agent architecture record (proposed on `claude/adr-0037-agent-architecture`) and this record's question, the Durable Object (recommended) against longer time limits (OD-2026-10-25-4):

> for budget why we limiting anything? it should be very simple credit based system like suppose we give user 1000credits it will be spend on the agentic work so that creidt will bcome limit itself no need to hardcode all of that bullshit. and for one i want it to be truty multi agent system so the agents can be orchestrated by the main agent in any way no need to limit to a single agent call only. for 2 why we adding limit on characters? it might strip important information i think only needs to be structured. for other option use the recommded one

The owner's words for this record are "for other option use the recommded one". The lead stated to the owner, in reply, that "use the recommended one" is taken as approval of the recommended option for this record: the Durable Object that runs the connector's scheduled jobs beside the database. The rest of the statement answers the agent architecture record's questions and is recorded in OD-2026-10-25-4.

The owner then approved this record in so many words, in chat on 2026-10-25 (OD-2026-10-25-5):

> approve ADR-0038 to use durable objects

What it approves: this record as written, items 1 to 5. The longer time limits (the routine stopgap) are not taken. The CLAUDE.md and `docs/plan/build-plan.md` stack-line wording above is applied in its own follow-up; a change to CLAUDE.md's standing rules has needed the owner's own confirmation of the text before (OD-2026-10-23-10).
