// M3 PR-1 (ADR-0022 item 16): Settings > Governance, the workspace's model default and
// member ceiling. Every catalogue entry shows its credits per product and the run's
// product limit; model and effort are opaque keys, labelled from copy. Only a holder of
// governance.model_default.revise (the server says canRevise) gets the form; everyone else
// sees the values and which entries they may pick.
import { useEffect, useId, useState } from "react";
import { copy } from "../copy";
import type { ModelCatalogueView, WorkspaceView } from "../model";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { Button } from "../components/controls";
import { Tag } from "../components/display";
import { outcomeState } from "../components/feedback";
import { CommandFeedback } from "./entry";

const label = (key: string) => copy.models.labels[key] ?? key;
const entryKey = (e: { readonly model: string; readonly effort: string }) =>
  `${e.model}|${e.effort}`;

function DefaultForm({
  ws,
  view,
  onSaved,
}: {
  readonly ws: string;
  readonly view: ModelCatalogueView;
  readonly onSaved: () => void;
}) {
  const services = useServices();
  const selectId = useId();
  const ceilingId = useId();
  const [selected, setSelected] = useState(entryKey(view.workspaceDefault));
  const [ceiling, setCeiling] = useState(String(view.ceiling));
  useEffect(() => {
    setSelected(entryKey(view.workspaceDefault));
    setCeiling(String(view.ceiling));
  }, [view]);
  const dirty = selected !== entryKey(view.workspaceDefault) || ceiling !== String(view.ceiling);
  useDirty(dirty);
  const save = useCommand<
    {
      model: string;
      effort: string;
      maxCreditsPerProduct: number;
      expectedRevision: number | null;
    },
    { readonly revision: number }
  >({
    marker: { workspaceId: ws, kind: "model_default" },
    send: (c) => services.port.models.reviseDefault(ws, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok" || (outcome.kind === "conflict" && outcome.recheck)) onSaved();
    },
  });
  const entry = view.entries.find((e) => entryKey(e) === selected) ?? null;
  const ceilingValue = /^[1-9][0-9]?$/.test(ceiling) ? Number(ceiling) : null;
  // A ceiling below the default's credits would refuse every member's default.
  const valid = entry !== null && ceilingValue !== null && entry.creditsPerProduct <= ceilingValue;
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !entry || ceilingValue === null) return;
        void save.submit({
          model: entry.model,
          effort: entry.effort,
          maxCreditsPerProduct: ceilingValue,
          expectedRevision: view.revision,
        });
      }}
    >
      <div className="field">
        <label htmlFor={selectId}>{copy.models.default}</label>
        <select id={selectId} value={selected} onChange={(e) => setSelected(e.target.value)}>
          {view.entries.map((e) => (
            <option key={entryKey(e)} value={entryKey(e)}>
              {`${label(e.model)} · ${label(e.effort)} · ${copy.models.credits(e.creditsPerProduct)}`}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ceilingId}>{copy.models.ceiling}</label>
        <input
          id={ceilingId}
          inputMode="numeric"
          value={ceiling}
          maxLength={2}
          onChange={(e) => setCeiling(e.target.value)}
          aria-describedby={ceilingId + "-hint"}
        />
        <small id={ceilingId + "-hint"}>{copy.models.ceilingHint}</small>
      </div>
      <Button variant="primary" type="submit" disabled={!valid || !dirty || save.busy}>
        {copy.models.save}
      </Button>
      <CommandFeedback
        phase={save.phase}
        onCheckAgain={save.checkAgain}
        onRetry={save.retry}
        success={copy.models.saved}
        messages={{ conflict: (o) => (o.recheck ? copy.models.changed : o.message) }}
      />
    </form>
  );
}

export function ModelDefaultScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [models, reload] = useRead(`${ws}|models`, () => services.port.models.list(ws));
  return (
    <div className="page">
      <header className="page-header">
        <h1>{copy.models.title}</h1>
      </header>
      <p>{copy.models.intro}</p>
      {models.kind !== "ok" ? (
        outcomeState(models, reload)
      ) : (
        <section className="panel" aria-labelledby="model-default-title">
          <div className="panel-head">
            <h2 id="model-default-title">{copy.models.catalogue(models.value.catalogueVersion)}</h2>
          </div>
          <ul className="item-list" data-testid="model-catalogue">
            {models.value.entries.map((e) => (
              <li key={entryKey(e)} className="item item-stacked">
                <p>{`${label(e.model)} · ${label(e.effort)}`}</p>
                <p className="meta">
                  {copy.models.credits(e.creditsPerProduct)} ·{" "}
                  {copy.models.limit(e.runProductLimit)}
                </p>
                <p className="meta">
                  {entryKey(e) === entryKey(models.value.workspaceDefault) ? (
                    <Tag tone="accent">{copy.models.default}</Tag>
                  ) : null}
                  {/* The ceiling tag compares the entry with the member ceiling itself; what this
                      person may pick (a reviser may pick above it) shows separately. */}
                  <Tag tone={e.creditsPerProduct <= models.value.ceiling ? "success" : "neutral"}>
                    {e.creditsPerProduct <= models.value.ceiling
                      ? copy.models.withinCeiling
                      : copy.models.aboveCeiling}
                  </Tag>
                  {e.allowedForMember && e.creditsPerProduct > models.value.ceiling ? (
                    <Tag tone="accent">{copy.models.youCanPick}</Tag>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
          {models.value.canRevise ? (
            <DefaultForm ws={ws} view={models.value} onSaved={reload} />
          ) : (
            <p className="muted">{copy.models.readOnly}</p>
          )}
        </section>
      )}
    </div>
  );
}
