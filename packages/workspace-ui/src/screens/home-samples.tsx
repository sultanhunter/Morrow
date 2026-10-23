// The Home board's sections that have no backend yet (ADR-0032 Home; the UX
// recommendation's section 3.3): Today, Your projects, Yesterday at a glance, Ideas and
// the Ask Morrow panel. They render only from `samples.home`, which only the fixture
// adapter answers and only its `home_preview` scenario composes: a default-off switch.
// Each card says it is sample data. Nothing here sends anything; Dismiss only hides an
// idea on this page, and moves focus to the next idea's Dismiss (or to the Ideas heading
// once none are left, where the card stays with a line saying so).
import { useEffect, useRef, useState } from "react";
import { copy } from "../copy";
import type { HomeSamplesView, Id, SampleHealth } from "../model";
import { RouteLink } from "../components/controls";
import { AgentAvatar, AgentName, agentNames } from "../components/avatars";
import { Icon, Tag, type Glyph, type TagTone } from "../components/display";
import { Button } from "../components/controls";

const health: Readonly<Record<SampleHealth, readonly [TagTone, Glyph]>> = {
  on_track: ["success", "check"],
  behind: ["warning", "alert"],
  working: ["info", "half"],
  needs_you: ["caution", "ring"],
};
const today: Readonly<Record<"done" | "working" | "to_do", readonly [TagTone, Glyph]>> = {
  done: ["success", "check"],
  working: ["info", "half"],
  to_do: ["neutral", "circle"],
};
function HealthTag({ value }: { readonly value: SampleHealth }) {
  const [tone, glyph] = health[value];
  return (
    <Tag tone={tone} glyph={glyph}>
      {copy.home.status[value]}
    </Tag>
  );
}
function SampleNote() {
  return <p className="sample-note">{copy.home.samples.note}</p>;
}

export function TodayCard({ samples }: { readonly samples: HomeSamplesView }) {
  return (
    <section className="card" data-card="today" aria-labelledby="home-today-title">
      <div className="card-head">
        <h2 id="home-today-title">{copy.home.samples.todayTitle}</h2>
        <p className="card-caption">{copy.home.samples.todaySource}</p>
      </div>
      <SampleNote />
      <ul className="row-list">
        {samples.today.map((item) => {
          const [tone, glyph] = today[item.status];
          return (
            <li key={item.when + item.title} className="row">
              <span className="row-when">{item.when}</span>
              {item.agent ? <AgentAvatar agent={item.agent} size={28} /> : null}
              <span className="row-text">
                <span className="row-title">{item.title}</span>
                <span className="row-sub">{`${item.who} · ${item.where}`}</span>
              </span>
              <Tag tone={tone} glyph={glyph}>
                {copy.home.status[item.status]}
              </Tag>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ProjectsCard({
  ws,
  samples,
}: {
  readonly ws: Id;
  readonly samples: HomeSamplesView;
}) {
  return (
    <section className="card" data-card="projects" aria-labelledby="home-projects-title">
      <div className="card-head">
        <h2 id="home-projects-title">{copy.home.samples.projectsTitle}</h2>
        <RouteLink route="work" params={{ workspaceId: ws }} className="card-link">
          {copy.home.seeAllProjects}
        </RouteLink>
      </div>
      <SampleNote />
      <h3 className="group-label" id="home-projects-dated">
        {copy.home.samples.projectsGroup}
      </h3>
      <ul className="row-list" aria-labelledby="home-projects-dated">
        {samples.projects.map((project) => (
          <li key={project.id}>
            <RouteLink
              route="project"
              params={{ workspaceId: ws, projectId: project.id }}
              className="row row-link"
            >
              <span className="row-text">
                <span className="row-title">{project.name}</span>
                <span className="row-sub">{`${copy.shell.ends(project.ends)} · ${project.summary}`}</span>
              </span>
              <HealthTag value={project.health} />
              <Icon name="forward" />
            </RouteLink>
          </li>
        ))}
      </ul>
      <h3 className="group-label" id="home-projects-everyday">
        {copy.home.samples.everydayGroup}
      </h3>
      <ul className="row-list" aria-labelledby="home-projects-everyday">
        {samples.everyday.map((area) => (
          <li key={area.name}>
            <RouteLink route="work" params={{ workspaceId: ws }} className="row row-link">
              <span className="row-text">
                <span className="row-title">{area.name}</span>
                <span className="row-sub">{area.summary}</span>
              </span>
              {area.health ? <HealthTag value={area.health} /> : null}
              <Icon name="forward" />
            </RouteLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GlanceCard({ samples }: { readonly samples: HomeSamplesView }) {
  return (
    <section className="card" data-card="glance" aria-labelledby="home-glance-title">
      <div className="card-head">
        <h2 id="home-glance-title">{copy.home.samples.glanceTitle}</h2>
        <p className="card-caption">
          <AgentAvatar agent="analyst" size={24} />
          <AgentName agent="analyst" />
        </p>
      </div>
      <SampleNote />
      <dl className="metrics">
        {samples.glance.metrics.map((metric) => (
          <div key={metric.label} className="metric">
            <dt>{metric.label}</dt>
            <dd className="metric-value">{metric.value}</dd>
            {metric.note ? <dd className="metric-note">{metric.note}</dd> : null}
          </div>
        ))}
      </dl>
      <div className="agent-take">
        <p className="agent-take-head">
          <AgentAvatar agent="analyst" size={24} />
          <span>{copy.home.samples.take(agentNames.analyst)}</span>
        </p>
        <p>{samples.glance.take}</p>
      </div>
      <p className="card-caption source-line">
        <Icon name="store" size={16} />
        <span>{samples.glance.source}</span>
      </p>
    </section>
  );
}

export function IdeasCard({ samples }: { readonly samples: HomeSamplesView }) {
  const [dismissed, setDismissed] = useState<readonly Id[]>([]);
  // Where focus goes after a dismissal: an idea's Dismiss button, or the card's heading.
  const [focusTo, setFocusTo] = useState<Id | "heading" | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const ideas = samples.ideas.filter((idea) => !dismissed.includes(idea.id));
  useEffect(() => {
    if (focusTo === null) return;
    if (focusTo === "heading") heading.current?.focus();
    else
      [...(list.current?.querySelectorAll<HTMLElement>("[data-idea]") ?? [])]
        .find((item) => item.dataset.idea === focusTo)
        ?.querySelector<HTMLElement>("button")
        ?.focus();
    setFocusTo(null);
  }, [focusTo]);
  const dismiss = (index: number) => {
    const rest = ideas.filter((_, i) => i !== index);
    const next = rest[index] ?? rest[index - 1] ?? null;
    setDismissed((ids) => [...ids, ideas[index]!.id]);
    setFocusTo(next ? next.id : "heading");
  };
  return (
    <section className="card" data-card="ideas" aria-labelledby="home-ideas-title">
      <div className="card-head">
        <h2 id="home-ideas-title" ref={heading} tabIndex={-1}>
          {copy.home.samples.ideasTitle}
        </h2>
        <p className="card-caption">{copy.home.samples.ideasNote}</p>
      </div>
      <SampleNote />
      {ideas.length ? (
        <ul className="idea-list" ref={list}>
          {ideas.map((idea, index) => {
            const name = idea.agent === "specialist" ? "Specialist" : agentNames[idea.agent];
            return (
              <li key={idea.id} className="idea" data-idea={idea.id}>
                <p className="idea-head">
                  <AgentAvatar agent={idea.agent} size={28} />
                  <AgentName agent={idea.agent} />
                </p>
                <p className="idea-text">{idea.text}</p>
                <p className="row-sub">{idea.helps}</p>
                <div className="idea-actions">
                  <Button
                    variant="quiet"
                    aria-label={copy.home.samples.dismissIdea(name)}
                    onClick={() => dismiss(index)}
                  >
                    {copy.home.samples.dismiss}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">{copy.home.samples.noIdeas}</p>
      )}
    </section>
  );
}

export function AskPanel({ ws, samples }: { readonly ws: Id; readonly samples: HomeSamplesView }) {
  return (
    <section className="ask-panel" aria-labelledby="home-ask-title">
      <div className="ask-panel-head">
        <AgentAvatar agent="morrow" size={28} />
        <h2 id="home-ask-title">{copy.shell.askMorrow}</h2>
      </div>
      <SampleNote />
      <p className="reading">{copy.home.samples.askIntro}</p>
      <h3 className="group-label" id="home-ask-recent">
        {copy.home.samples.recent}
      </h3>
      <ul className="row-list" aria-labelledby="home-ask-recent">
        {samples.recentAsks.map((ask) => (
          <li key={ask.when + ask.asked}>
            <RouteLink route="ask" params={{ workspaceId: ws }} className="row row-link">
              <span className="row-text">
                <span className="row-title">{`“${ask.asked}”`}</span>
                <span className="row-sub">{`${ask.when} · ${ask.outcome}`}</span>
              </span>
              <Icon name="forward" />
            </RouteLink>
          </li>
        ))}
      </ul>
      <RouteLink route="ask" params={{ workspaceId: ws }} className="button button-secondary">
        {copy.home.samples.openAsk}
      </RouteLink>
      <p className="card-caption">{copy.home.samples.privacy}</p>
    </section>
  );
}
