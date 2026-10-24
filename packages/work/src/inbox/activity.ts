import { workPermissions } from "@morrow/contracts/work-permissions";
import { listingFieldPaths, storeResource } from "@morrow/policy/store-resource";
import { decideOn, stopAllowed } from "../agents/commands.js";
import { installationResource, listingsRelease } from "../agents/listings.js";
import { disconnectAllowed } from "../connections/commands.js";
import type { WorkTx } from "../connection.js";
import { WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { decodeCursor, encodeCursor } from "../contract-mapping.js";
import { decideWork } from "../permissions.js";
import { proposalReader } from "./read.js";

// GET /work/activity (v1 PR 15; Settings > Activity): what people, agents, Morrow and
// Shopify did in this workspace, newest first, from the records that exist today (the
// approval decisions, the gateway's operation transitions, the KillSwitchRecords, the
// system connection stops, the agent installations and the Listings runs). Nobody can
// change or delete these records, and conversations with Morrow are not among them.
// Each entry is shown only to a person who may see the record it comes from, by the same
// rule as its own screen:
//   decision, change   the proposal's reviewer or its own proposer or requester
//   stop               its actor, or a person who holds the same stop right on that store
//                      (Stop AI work on the installation, Disconnect store on the store)
//   system_stop        a person who holds the store's disconnect right
//   installation       its owner, or a person who may stop it
//   run                task.read view and the run's store product read on its fields
//                      (as GET /work/tasks/:taskId/runs)
// Entries carry ids, closed codes, counts and times; the screen words them. Never a
// product's content or id, a person's reason or comment, a provider id or a credential.
// A page scans at most 100 records and returns the visible ones (at most `limit`), with
// the cursor of the last record it scanned.

export const activityLimits = Object.freeze({ defaultPage: 25, maxPage: 50, scan: 100 });
export type ActivityActor =
  | { readonly kind: "person"; readonly principalId: string }
  | { readonly kind: "morrow" }
  | { readonly kind: "shopify" };
export type ActivityEntry =
  | {
      readonly kind: "approval_decided";
      readonly decision: "approve" | "reject";
      readonly proposalId: string;
      readonly taskId: string | null;
      readonly storeId: string | null;
      readonly targetCount: number;
    }
  | {
      readonly kind: "change_outcome";
      readonly outcome: "verified" | "not_applied" | "unknown" | "set_aside";
      readonly reasonCode: string | null;
      readonly operationId: string;
      readonly proposalId: string;
      readonly taskId: string;
      readonly storeId: string;
    }
  | {
      readonly kind: "ai_work_stopped";
      readonly storeId: string;
      readonly agent: "listings";
      readonly alreadyStopped: boolean;
    }
  | {
      readonly kind: "store_disconnected";
      readonly storeId: string;
      readonly alreadyStopped: boolean;
    }
  | {
      readonly kind: "store_ended";
      readonly storeId: string;
      readonly reason: "uninstalled" | "scopes_changed" | "other";
    }
  | { readonly kind: "agent_added"; readonly storeId: string; readonly agent: "listings" | "other" }
  | {
      readonly kind: "drafts_requested";
      readonly taskId: string;
      readonly storeId: string;
      readonly productCount: number;
      readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      readonly drafted: number;
      readonly failed: number;
    };
export type ActivityRecord = {
  readonly id: string;
  readonly at: string;
  readonly actor: ActivityActor;
} & ActivityEntry;
export interface ActivityPage {
  readonly entries: readonly ActivityRecord[];
  readonly next: string | null;
}

type Row = Readonly<Record<string, unknown>>;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const codePattern = /^[a-z][a-z0-9_]{0,63}$/;
const str = (row: Row, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
const opt = (row: Row, key: string) =>
  row[key] === null || row[key] === undefined ? null : str(row, key);
const id = (row: Row, key: string) => {
  const value = str(row, key);
  if (!idPattern.test(value)) throw new WorkContextUnavailable();
  return value;
};
const code = (row: Row, key: string) => {
  const value = opt(row, key);
  if (value !== null && !codePattern.test(value)) throw new WorkContextUnavailable();
  return value;
};
const count = (row: Row, key: string) => {
  const value = str(row, key);
  if (!/^(0|[1-9][0-9]{0,3})$/.test(value)) throw new WorkContextUnavailable();
  return Number(value);
};
const runStatuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
const changeOutcomes: Readonly<
  Record<string, "verified" | "not_applied" | "unknown" | "set_aside">
> = Object.freeze({
  verified: "verified",
  failed: "not_applied",
  conflict: "not_applied",
  uncertain: "unknown",
  cancel_requested: "set_aside",
});

/** One request's visibility checks, each cached: proposals, store rights and run reads. */
function visibility(tx: WorkTx, a: WorkAuthority) {
  const readable = proposalReader(tx, a);
  const rights = new Map<string, Promise<boolean>>();
  const cached = (key: string, decide: () => Promise<boolean>) => {
    let value = rights.get(key);
    if (!value) {
      value = decide();
      rights.set(key, value);
    }
    return value;
  };
  const org = a.actor.organizationId;
  const ws = a.resource.workspaceId;
  let taskRead: Promise<boolean> | null = null;
  return {
    /** The proposal's task, store and size when the viewer may see its records. */
    async proposal(proposalId: string) {
      const stored = await readable(proposalId);
      if (!stored) return null;
      return {
        taskId: stored.proposal.taskId ?? null,
        storeId: stored.proposal.storeId,
        targets: stored.proposal.targets.length,
      };
    },
    mayStopInstallation(storeId: string, connectionId: string, installationId: string) {
      return cached(`stop|${storeId}|${connectionId}|${installationId}`, () =>
        stopAllowed(
          a,
          installationResource(storeResource(org, ws, storeId, connectionId), installationId),
        ),
      );
    },
    mayDisconnect(storeId: string, connectionId: string) {
      return cached(`disconnect|${storeId}|${connectionId}`, () =>
        disconnectAllowed(a, storeResource(org, ws, storeId, connectionId)),
      );
    },
    mayReadRun(storeId: string, connectionId: string, fields: readonly string[]) {
      taskRead ??= (async () => {
        const rule = workPermissions["task.read"];
        return (await decideWork(a, rule.capabilityId, "view", rule.fields)).allowed;
      })();
      return cached(`run|${storeId}|${connectionId}|${fields.join(",")}`, async () => {
        if (!(await taskRead)) return false;
        const store = storeResource(org, ws, storeId, connectionId);
        return (await decideOn(a, store, "catalog.products.read", "view", fields)).decision.allowed;
      });
    },
  };
}
type Visibility = ReturnType<typeof visibility>;

const person = (principalId: string | null): ActivityActor => {
  if (principalId === null || !idPattern.test(principalId)) throw new WorkContextUnavailable();
  return { kind: "person", principalId };
};
function parseFields(value: string | null): readonly string[] {
  if (value === null) throw new WorkContextUnavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WorkContextUnavailable();
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (f) => typeof f === "string" && (listingFieldPaths as readonly string[]).includes(f),
    )
  )
    throw new WorkContextUnavailable();
  return parsed as string[];
}

/** One scanned record as this viewer may see it, or null when they may not. */
async function entryOf(row: Row, v: Visibility, a: WorkAuthority): Promise<ActivityRecord | null> {
  const kind = str(row, "kind");
  const base = { id: id(row, "id"), at: str(row, "at") };
  switch (kind) {
    case "decision": {
      const decision = str(row, "code");
      if (decision !== "approve" && decision !== "reject") throw new WorkContextUnavailable();
      const proposalId = id(row, "proposal_id");
      const seen = await v.proposal(proposalId);
      if (!seen) return null;
      return {
        ...base,
        actor: person(opt(row, "actor_principal_id")),
        kind: "approval_decided",
        decision,
        proposalId,
        taskId: seen.taskId,
        storeId: seen.storeId,
        targetCount: seen.targets,
      };
    }
    case "change": {
      const outcome = changeOutcomes[str(row, "code")];
      if (!outcome) throw new WorkContextUnavailable();
      const proposalId = id(row, "proposal_id");
      if (!(await v.proposal(proposalId))) return null;
      return {
        ...base,
        actor: { kind: "morrow" },
        kind: "change_outcome",
        outcome,
        reasonCode: code(row, "reason"),
        operationId: id(row, "target_id"),
        proposalId,
        taskId: id(row, "task_id"),
        storeId: id(row, "store_id"),
      };
    }
    case "stop": {
      const capability = str(row, "code");
      const storeId = id(row, "store_id");
      const connectionId = id(row, "connection_id");
      const actorId = id(row, "actor_principal_id");
      const prior = str(row, "reason");
      if (prior !== "active" && prior !== "already_stopped") throw new WorkContextUnavailable();
      const own = actorId === a.actor.principalId;
      if (capability === "agents.installation.disable") {
        if (!own && !(await v.mayStopInstallation(storeId, connectionId, id(row, "target_id"))))
          return null;
        return {
          ...base,
          actor: person(actorId),
          kind: "ai_work_stopped",
          storeId,
          agent: "listings",
          alreadyStopped: prior === "already_stopped",
        };
      }
      if (capability === "governance.connection.disconnect") {
        if (!own && !(await v.mayDisconnect(storeId, connectionId))) return null;
        return {
          ...base,
          actor: person(actorId),
          kind: "store_disconnected",
          storeId,
          alreadyStopped: prior === "already_stopped",
        };
      }
      throw new WorkContextUnavailable();
    }
    case "system_stop": {
      const storeId = id(row, "store_id");
      if (!(await v.mayDisconnect(storeId, id(row, "connection_id")))) return null;
      const reason = str(row, "code");
      return {
        ...base,
        actor: { kind: "shopify" },
        kind: "store_ended",
        storeId,
        reason:
          reason === "shopify_app_uninstalled"
            ? "uninstalled"
            : reason === "shopify_scopes_changed"
              ? "scopes_changed"
              : "other",
      };
    }
    case "installation": {
      const storeId = id(row, "store_id");
      const ownerId = id(row, "actor_principal_id");
      if (
        ownerId !== a.actor.principalId &&
        !(await v.mayStopInstallation(storeId, id(row, "connection_id"), id(row, "target_id")))
      )
        return null;
      return {
        ...base,
        actor: person(ownerId),
        kind: "agent_added",
        storeId,
        agent: str(row, "code") === listingsRelease.id ? "listings" : "other",
      };
    }
    case "run": {
      const storeId = id(row, "store_id");
      const fields = parseFields(opt(row, "fields"));
      if (!(await v.mayReadRun(storeId, id(row, "connection_id"), fields))) return null;
      const status = str(row, "code");
      if (!(runStatuses as readonly string[]).includes(status)) throw new WorkContextUnavailable();
      return {
        ...base,
        actor: person(opt(row, "actor_principal_id")),
        kind: "drafts_requested",
        taskId: id(row, "task_id"),
        storeId,
        productCount: count(row, "product_count"),
        status: status as (typeof runStatuses)[number],
        drafted: count(row, "products_drafted"),
        failed: count(row, "products_failed"),
      };
    }
  }
  throw new WorkContextUnavailable();
}

/** The `limit` query: 1 to 50, 25 when absent; anything else is "invalid". */
export function parseActivityLimit(value: string | undefined): number | "invalid" {
  if (value === undefined) return activityLimits.defaultPage;
  if (!/^[1-9][0-9]?$/.test(value) || Number(value) > activityLimits.maxPage) return "invalid";
  return Number(value);
}

/** One page of the activity log as this viewer may see it. */
export async function readActivity(
  tx: WorkTx,
  a: WorkAuthority,
  page: { readonly after: string | null; readonly limit: number },
): Promise<ActivityPage | "invalid"> {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > activityLimits.maxPage)
    return "invalid";
  let cursor: readonly [string | null, string | null] = [null, null];
  if (page.after !== null) {
    const decoded = decodeCursor(page.after);
    if (!decoded) return "invalid";
    cursor = decoded;
  }
  const rows = await tx.run("activityPage", [
    cursor[0],
    cursor[1],
    String(activityLimits.scan + 1),
  ]);
  const v = visibility(tx, a);
  const entries: ActivityRecord[] = [];
  let next: string | null = null;
  const scanned = rows.slice(0, activityLimits.scan);
  for (const [index, row] of scanned.entries()) {
    const entry = await entryOf(row, v, a);
    if (entry) entries.push(Object.freeze(entry));
    if (entries.length === page.limit) {
      next = index < rows.length - 1 ? encodeCursor(row) : null;
      break;
    }
  }
  if (entries.length < page.limit && rows.length > activityLimits.scan)
    next = encodeCursor(scanned[scanned.length - 1]!);
  return Object.freeze({ entries: Object.freeze(entries), next });
}
