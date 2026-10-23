// A project's conversation (ADR-0034 items 8 and 9): people's and agents' messages, code's
// one-line notes, Morrow's plan-change cards and the automatic Monday update. "Ask @Morrow"
// adds the typed coordinator mention to the person's own message: a request that starts
// one Morrow run with the project in view, never authority. Messages a viewer may not see
// are already left out by the server.
import { useId, useState, type FormEvent } from "react";
import type { Id } from "../model";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { Button, RouteLink } from "../components/controls";
import { StateView, outcomeState } from "../components/feedback";
import { CommandFeedback } from "../screens/entry";
import { projectsCopy } from "./copy";
import type { ProjectDetailView, ProjectUpdateView } from "./model";
import { HealthWord, MemberName } from "./parts";
import { PlanChangeCard } from "./plan-card";

const c = projectsCopy.conversation;
export const messageLimit = 16384;

export function UpdateCard({
  update,
  compact = false,
}: {
  readonly update: ProjectUpdateView;
  readonly compact?: boolean;
}) {
  const p = projectsCopy.project;
  return (
    <div className={`pj-update${compact ? " is-compact" : ""}`}>
      <p className="pj-meta">{p.updateBy(update.at)}</p>
      <p className="pj-update-title">
        <span dir="auto">{update.title}</span> <HealthWord health={update.health} />
      </p>
      <p dir="auto">{update.summary}</p>
      <dl className="pj-facts">
        {update.rows.map((row) => (
          <div key={row.label} className="pj-fact">
            <dt dir="auto">{row.label}</dt>
            <dd>
              <span dir="auto">{row.value}</span>
              {row.health ? <HealthWord health={row.health} /> : null}
              {row.note && !compact ? (
                <span className="pj-meta" dir="auto">
                  {row.note}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
        {update.doneSince && !compact ? (
          <div className="pj-fact">
            <dt>{p.doneSince}</dt>
            <dd dir="auto">{update.doneSince}</dd>
          </div>
        ) : null}
        {update.needsYou ? (
          <div className="pj-fact">
            <dt>{p.needsYou}</dt>
            <dd dir="auto">{update.needsYou}</dd>
          </div>
        ) : null}
        {update.credits && !compact ? (
          <div className="pj-fact">
            <dt>{p.credits}</dt>
            <dd dir="auto">{update.credits}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export function ProjectConversation({
  ws,
  project,
  version,
  onChanged,
}: {
  readonly ws: Id;
  readonly project: ProjectDetailView;
  /** Bumped when the page knows something new was posted (Plan next steps). */
  readonly version: number;
  /** Something in the project changed (a plan change applied): re-read the page. */
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const headingId = useId();
  const textId = useId();
  const [messages, reload] = useRead(
    `${ws}|projects.messages|${project.projectId}|${version}`,
    () => services.port.projects.messages(ws, project.projectId),
  );
  const [text, setText] = useState("");
  const [mention, setMention] = useState(false);
  const [checked, setChecked] = useState(false);
  const command = useCommand<{ text: string; mentionMorrow: boolean }, { readonly messageId: Id }>(
    {
      marker: { workspaceId: ws, kind: "project" },
      send: (cmd) => services.port.projects.post(ws, project.projectId, cmd),
      onOutcome: (outcome, sent) => {
        if (outcome.kind !== "ok") return;
        if (sent.current) {
          setText("");
          setMention(false);
          setChecked(false);
        }
        reload();
      },
    },
  );
  useDirty(text !== "" || command.busy);
  const canPost = project.actions.post && services.composed["projects.post"];
  const canMention = canPost && project.actions.mentionMorrow;
  const valid = text.trim() !== "" && text.length <= messageLimit && !text.includes("\0");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid || command.busy || !canPost) return;
    void command.submit({ text, mentionMorrow: canMention && mention });
  };
  return (
    <section className="pj-conversation" aria-labelledby={headingId}>
      <div className="pj-card-head">
        <h2 id={headingId}>{c.title}</h2>
        <Button variant="quiet" onClick={reload}>
          {c.refresh}
        </Button>
      </div>
      {messages.kind !== "ok" ? (
        outcomeState(messages, reload, { compact: true })
      ) : messages.value.messages.length ? (
        <ol className="pj-messages">
          {messages.value.messages.map((message) => {
            switch (message.kind) {
              case "line":
                return (
                  <li key={message.id} className="pj-line">
                    <span dir="auto">{message.text}</span>
                    <span className="pj-meta"> · {message.at}</span>
                  </li>
                );
              case "update":
                return (
                  <li key={message.id} className="pj-message">
                    <p className="pj-meta">{c.automatic}</p>
                    <UpdateCard update={message.update} compact />
                  </li>
                );
              case "plan_change":
                return (
                  <li key={message.id} className="pj-message">
                    <PlanChangeCard
                      ws={ws}
                      projectId={project.projectId}
                      card={message.card}
                      onChanged={() => {
                        reload();
                        onChanged();
                      }}
                    />
                  </li>
                );
              default:
                return (
                  <li key={message.id} className="pj-message">
                    <p className="pj-message-head">
                      <MemberName member={message.author} />
                      <span className="pj-meta">{message.at}</span>
                    </p>
                    {message.written ? <p className="pj-meta">{c.written}</p> : null}
                    <p dir="auto" className="pj-message-text">
                      {message.text}
                    </p>
                    {message.restricted ? (
                      <p className="pj-meta" dir="auto">
                        {message.restricted}
                      </p>
                    ) : null}
                  </li>
                );
            }
          })}
        </ol>
      ) : (
        <StateView kind="empty" compact message={c.empty} />
      )}
      {canPost ? (
        <form className="pj-composer" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={textId}>{c.messageLabel}</label>
            <textarea
              id={textId}
              dir="auto"
              value={text}
              maxLength={messageLimit}
              disabled={command.busy}
              aria-invalid={checked && !valid ? true : undefined}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          {canMention ? (
            <div className="pj-composer-mention">
              <Button aria-pressed={mention} onClick={() => setMention((m) => !m)}>
                {c.mention}
              </Button>
              {mention ? <p className="pj-meta">{c.mentionHint}</p> : null}
            </div>
          ) : null}
          <CommandFeedback
            phase={command.phase}
            onCheckAgain={command.checkAgain}
            onRetry={command.retry}
          />
          <div className="pj-composer-actions">
            <RouteLink route="ask" params={{ workspaceId: ws }} className="text-link">
              {c.privately}
            </RouteLink>
            <Button type="submit" variant="primary" disabled={command.busy}>
              {command.busy ? c.sending : c.send}
            </Button>
          </div>
        </form>
      ) : (
        <p className="pj-meta">{c.cannotPost}</p>
      )}
    </section>
  );
}
