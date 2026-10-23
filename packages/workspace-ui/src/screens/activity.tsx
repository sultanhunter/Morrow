// T7 PR 16: Settings > Activity (the SettingsActivity board): "Stop all AI work" at the top,
// wired to each store's existing stop (stop-all.tsx), then "What happened": what people,
// agents and Morrow did, newest first, with filters. Nobody can change or delete it, and
// conversations with Morrow are private, so they aren't listed. The list is fixture data in
// this build (PR 15 brings the activity log); its HTTP method is uncomposed and sends nothing.
// Undo and Download wait for their backends and are not drawn as working buttons.
import { useState } from "react";
import { outcomeState } from "../components/feedback";
import type { WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import {
  activityFilters,
  type ActivityEntryView,
  type ActivityFilter,
  type ActivityView,
} from "../team-model";
import { AgentAvatar, PersonAvatar } from "../sunrise/avatars";
import { sunriseCopy } from "../sunrise/copy";
import { AgentPill, Badge, Card } from "../sunrise/parts";
import { SettingsFrame } from "./settings-pages";
import { StopAllCard } from "./stop-all";

const a = sunriseCopy.activity;

function Entry({ entry }: { readonly entry: ActivityEntryView }) {
  const actor = entry.actor;
  return (
    <li className="sr-activity-row">
      <span className="sr-activity-time">{entry.time}</span>
      {actor.kind === "person" ? (
        <PersonAvatar initials={actor.initials} size={32} />
      ) : (
        <AgentAvatar
          character={actor.character}
          size={32}
          {...(actor.prop ? { prop: actor.prop } : {})}
        />
      )}
      <div className="sr-activity-text">
        <p>
          <span className="sr-row-title" dir="auto">
            {actor.name}
          </span>
          {actor.kind === "helper" && actor.character !== "morrow" ? (
            <>
              {" "}
              <AgentPill character={actor.character} />
            </>
          ) : null}{" "}
          <span dir="auto">{entry.what}</span>
        </p>
        <p className="sr-meta" dir="auto">
          {entry.detail}
        </p>
      </div>
      {entry.badge ? <Badge kind={entry.badge} /> : null}
    </li>
  );
}

function ActivityList({ view }: { readonly view: ActivityView }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const shown = view.entries.filter((e) => filter === "all" || e.category === filter);
  const days = [...new Set(shown.map((e) => e.day))];
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
          {view.entries.length === 0 ? a.empty : a.emptyFiltered}
        </p>
      ) : (
        days.map((day) => (
          <section key={day} className="sr-activity-day" aria-label={day}>
            <h3 className="sr-group-heading">{day}</h3>
            <ol className="sr-activity-list">
              {shown
                .filter((e) => e.day === day)
                .map((e) => (
                  <Entry key={e.id} entry={e} />
                ))}
            </ol>
          </section>
        ))
      )}
      <p className="sr-footnote">{a.private}</p>
    </>
  );
}

export function ActivityScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [activity, reload] = useRead(`${ws}|settings.activity`, () =>
    services.port.settings.activity(ws),
  );
  return (
    <SettingsFrame
      workspaceId={ws}
      current="activity"
      title={a.title}
      scope={a.intro(workspace.displayName)}
    >
      <StopAllCard workspaceId={ws} />
      <Card title={a.list} flush>
        {activity.kind === "ok" ? (
          <ActivityList view={activity.value} />
        ) : (
          <div className="sr-card-intro">{outcomeState(activity, reload, { compact: true })}</div>
        )}
      </Card>
    </SettingsFrame>
  );
}
