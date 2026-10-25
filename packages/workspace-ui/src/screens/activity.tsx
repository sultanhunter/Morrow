// Settings > Activity (the SettingsActivity board): "Stop all AI work" at the top, wired to
// each store's existing stop (stop-all.tsx; person-only, typed confirmation), then "What
// happened": what people, agents, Morrow and Shopify did, newest first, with filters and
// "Show earlier". v1 PR 15 brings the log: GET /work/activity over the records that exist
// (approval decisions, the gateway's results, stops, the store's connection, agents added
// and requests to Listings). The server shows each entry only to a person who may see its
// record; the entries carry ids, codes and counts, which this screen words. Nobody can
// change or delete it, and conversations with Morrow are private, so they aren't listed.
// Undo and Download wait for their backends and are not drawn as working buttons.
import { useCallback, useMemo, useState } from "react";
import { copy } from "../copy";
import {
  activityCategory,
  activityFilters,
  type ActivityFilter,
  type ActivityRecordView,
} from "../inbox-model";
import { personLabel, type Id, type Page, type WorkspaceView } from "../model";
import type { Outcome } from "../port";
import { useServices } from "../services";
import { Button } from "../components/controls";
import { outcomeState } from "../components/feedback";
import { AgentAvatar } from "../sunrise/avatars";
import { sunriseCopy } from "../sunrise/copy";
import { inboxCopy } from "../sunrise/inbox-copy";
import { Badge, Card, SrIcon, type BadgeKind } from "../sunrise/parts";
import { SettingsPage } from "./settings-pages";
import { StopAllCard } from "./stop-all";
import { usePaged } from "./work";

const a = sunriseCopy.activity;
const w = inboxCopy.activity;

/** One record in plain words: who, what they did, the detail line, a badge and a filter. */
export interface ActivityLine {
  readonly actor: { readonly kind: "person" | "morrow" | "shopify"; readonly name: string };
  readonly what: string;
  readonly detail: string;
  readonly badge: BadgeKind | null;
  readonly category: ReturnType<typeof activityCategory>;
}
export function describeActivity(r: ActivityRecordView): ActivityLine {
  const actor =
    r.actor.kind === "person"
      ? {
          kind: "person" as const,
          name: personLabel({
            principalId: r.actor.principalId,
            kind: "human",
            label: null,
            isSelf: null,
          }),
        }
      : r.actor.kind === "morrow"
        ? { kind: "morrow" as const, name: w.actors.morrow }
        : { kind: "shopify" as const, name: w.actors.shopify };
  const line = (what: string, detail: string, badge: BadgeKind | null = null): ActivityLine => ({
    actor,
    what,
    detail,
    badge,
    category: activityCategory(r),
  });
  switch (r.kind) {
    case "approval_decided":
      return r.decision === "approve"
        ? line(w.approved(r.targetCount), w.suggestedBy)
        : line(w.declined(r.targetCount), w.declinedDetail);
    case "change_outcome":
      switch (r.outcome) {
        case "verified":
          return line(w.verified, w.suggestedBy, "updated_in_shopify");
        case "not_applied":
          return line(
            w.notApplied,
            (r.reasonCode !== null ? copy.review.reasons[r.reasonCode] : undefined) ??
              copy.status.operation.failed,
          );
        case "unknown":
          return line(w.unknown, w.unknownDetail, "needs_you");
        case "set_aside":
          return line(w.setAside, w.setAsideDetail);
      }
      break;
    case "ai_work_stopped":
      return line(w.stopped, r.alreadyStopped ? w.alreadyStopped : w.stoppedDetail, "stopped");
    case "store_disconnected":
      return line(
        w.disconnected,
        r.alreadyStopped ? w.alreadyDisconnected : w.disconnectedDetail,
        "stopped",
      );
    case "store_ended":
      return line(
        r.reason === "uninstalled"
          ? w.removed
          : r.reason === "scopes_changed"
            ? w.permissions
            : w.ended,
        w.endedDetail,
        "paused",
      );
    case "agent_added":
      return line(r.agent === "listings" ? w.addedListings : w.addedOther, w.addedDetail);
    case "drafts_requested":
      return line(
        w.asked(r.productCount),
        r.status === "queued" || r.status === "running"
          ? w.working
          : r.status === "succeeded"
            ? w.ready(r.drafted, r.failed)
            : r.status === "cancelled"
              ? w.cancelled
              : w.notFinished,
        r.status === "queued" || r.status === "running"
          ? "working"
          : r.status === "succeeded" && r.drafted > 0
            ? "suggested"
            : null,
      );
  }
  throw Error("ACTIVITY_KIND_UNKNOWN");
}

const timeOfDay = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const longDay = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
/** The day heading a record sits under, from the viewer's own clock. */
export function activityDay(at: string, now: Date): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return w.earlier;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return w.today(longDay.format(date));
  if (dayKey(date) === dayKey(yesterday)) return w.yesterday(longDay.format(date));
  return longDay.format(date);
}
/** The time of day: the day heading above it says which day. */
function activityTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : timeOfDay.format(date);
}

function Entry({ record }: { readonly record: ActivityRecordView }) {
  const line = describeActivity(record);
  return (
    <li className="sr-activity-row" data-kind={record.kind}>
      <span className="sr-activity-time">
        <time dateTime={record.at}>{activityTime(record.at)}</time>
      </span>
      {line.actor.kind === "morrow" ? (
        <AgentAvatar character="morrow" size={32} />
      ) : (
        <span className="sr-activity-lead" aria-hidden="true">
          <SrIcon name={line.actor.kind === "shopify" ? "store" : "people"} />
        </span>
      )}
      <div className="sr-activity-text">
        <p>
          <span className="sr-row-title" dir="auto">
            {line.actor.name}
          </span>{" "}
          <span>{line.what}</span>
        </p>
        <p className="sr-meta">{line.detail}</p>
      </div>
      {line.badge ? <Badge kind={line.badge} /> : null}
    </li>
  );
}

function ActivityList({ ws }: { readonly ws: Id }) {
  const services = useServices();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const now = useMemo(() => new Date(), []);
  const loadPage = useCallback(
    async (after: string | null): Promise<Outcome<Page<ActivityRecordView>>> => {
      const outcome = await services.port.inbox.activity(ws, after);
      return outcome.kind === "ok"
        ? { ...outcome, value: { items: outcome.value.entries, next: outcome.value.next } }
        : outcome;
    },
    [services, ws],
  );
  const paged = usePaged<ActivityRecordView>(`${ws}|activity`, loadPage);
  if (paged.first.kind !== "ok")
    return (
      <div className="sr-card-intro">
        {outcomeState(paged.first, paged.reload, { compact: true })}
      </div>
    );
  const shown = paged.items.filter((r) => filter === "all" || activityCategory(r) === filter);
  const days = [...new Set(shown.map((r) => activityDay(r.at, now)))];
  return (
    <>
      <ul className="sr-chips sr-activity-filters" aria-label={a.filtersLabel}>
        {activityFilters.map((f) => (
          <li key={f}>
            <button
              type="button"
              className="sr-chip"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {a.filters[f]}
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 ? (
        <p className="sr-card-intro sr-muted">
          {/* A page can hold no record this person may see while older ones exist: never
              "nothing happened" while Show earlier still has somewhere to go. */}
          {paged.next !== null
            ? paged.items.length === 0
              ? w.noneRecent
              : w.noneOfKindRecent
            : paged.items.length === 0
              ? a.empty
              : a.emptyFiltered}
        </p>
      ) : (
        days.map((day) => (
          <section key={day} className="sr-activity-day" aria-label={day}>
            <h3 className="sr-group-heading">{day}</h3>
            <ol className="sr-activity-list" data-testid="activity-entries">
              {shown
                .filter((r) => activityDay(r.at, now) === day)
                .map((r) => (
                  <Entry key={r.id} record={r} />
                ))}
            </ol>
          </section>
        ))
      )}
      {paged.next !== null ? (
        <div className="sr-card-intro sr-activity-more">
          <Button onClick={paged.loadMore} disabled={paged.loadingMore}>
            {w.showEarlier}
          </Button>
          {paged.moreFailed ? (
            <p role="alert" className="sr-error">
              {w.earlierFailed}
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="sr-footnote">{a.private}</p>
    </>
  );
}

export function ActivityScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const ws = workspace.id;
  return (
    <SettingsPage
      workspaceId={ws}
      current="activity"
      title={a.title}
      scope={a.intro(workspace.displayName)}
    >
      <StopAllCard workspaceId={ws} />
      <Card title={a.list} flush>
        <ActivityList ws={ws} />
      </Card>
    </SettingsPage>
  );
}
