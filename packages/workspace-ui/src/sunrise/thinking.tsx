// T7 PR 16: "How this agent thinks" (ADR-0027 item 12; the Agent and Team boards): Haiku,
// Sonnet or Opus 5.5 at Low, Medium or High. Bound to the existing governance where it
// exists: the Listings agent's choice is the workspace model default, read with
// `models.list` and saved with `models.reviseDefault` (its revision; the member ceiling is
// sent unchanged, so a choice above it can't be saved here). Every other helper uses
// `team.reviseThinking`. The server decides who may change it; the screen only shows that.
// A save whose outcome is unknown keeps its re-entry marker ("model_default" or "thinking"),
// so its dialog may close: the shell then says the change may have been saved.
import { useEffect, useId, useState } from "react";
import { Button, Dialog, RouteLink } from "../components/controls";
import type { Id, ModelCatalogueView } from "../model";
import { copy } from "../copy";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { outcomeState } from "../components/feedback";
import { CommandFeedback } from "../screens/entry";
import {
  optionsFromCatalogue,
  optionsFromEstimates,
  thinkingEfforts,
  thinkingModels,
  type ThinkingChoice,
  type ThinkingOption,
  type ThinkingView,
} from "../team-model";
import { sunriseCopy } from "./copy";
import { SrIcon, settingsRoutes } from "./parts";

const t = sunriseCopy.thinking;
export const modelName = (key: string) => sunriseCopy.models[key]?.name ?? key;
export const effortName = (key: string) => sunriseCopy.efforts[key]?.name ?? key;
export const choiceText = (c: ThinkingChoice) => t.choice(modelName(c.model), effortName(c.effort));
const same = (a: ThinkingChoice, b: ThinkingChoice) => a.model === b.model && a.effort === b.effort;
const find = (options: readonly ThinkingOption[], c: ThinkingChoice) =>
  options.find((o) => same(o, c)) ?? null;

function estimateText(option: ThinkingOption | null): string {
  if (option === null) return t.notOffered;
  if (option.unit === "product")
    return option.fits
      ? t.perProduct(option.typical)
      : t.perProductOver(option.typical, option.limit ?? 0);
  return option.fits
    ? t.perJob(option.typical, option.most ?? option.typical)
    : t.perJobOver(option.typical, option.most ?? option.typical);
}

/** Two radio groups of cards; each card's estimate follows the other group's choice. */
export function ThinkingPicker({
  value,
  options,
  onChange,
  disabled = false,
}: {
  readonly value: ThinkingChoice;
  readonly options: readonly ThinkingOption[];
  readonly onChange: (next: ThinkingChoice) => void;
  readonly disabled?: boolean;
}) {
  const name = useId();
  const groups = [
    {
      key: "model",
      legend: t.model,
      hint: t.modelHint,
      keys: thinkingModels as readonly string[],
      label: (k: string) => sunriseCopy.models[k]!,
      choice: (k: string) => ({ model: k, effort: value.effort }),
      selected: value.model,
    },
    {
      key: "effort",
      legend: t.effort,
      hint: t.effortHint,
      keys: thinkingEfforts as readonly string[],
      label: (k: string) => sunriseCopy.efforts[k]!,
      choice: (k: string) => ({ model: value.model, effort: k }),
      selected: value.effort,
    },
  ];
  return (
    <div className="sr-thinking-picker">
      {groups.map((g) => (
        <fieldset key={g.key} className="sr-fieldset" aria-describedby={`${name}-${g.key}-hint`}>
          <legend className="sr-subheading">{g.legend}</legend>
          <p id={`${name}-${g.key}-hint`} className="sr-help">
            {g.hint}
          </p>
          <div className="sr-options">
            {g.keys.map((k) => {
              const option = find(options, g.choice(k));
              const checked = g.selected === k;
              return (
                <label
                  key={k}
                  className={`sr-option${checked ? " is-checked" : ""}${option === null ? " is-off" : ""}`}
                >
                  <input
                    type="radio"
                    className="sr-radio"
                    name={`${name}-${g.key}`}
                    value={k}
                    checked={checked}
                    disabled={disabled || option === null}
                    onChange={() => onChange(g.choice(k))}
                  />
                  <span className="sr-option-text">
                    <span className="sr-option-name">{g.label(k).name}</span>
                    <span className="sr-option-about">{g.label(k).about}</span>
                    <span
                      className={`sr-option-estimate${option?.fits === false ? " is-over" : ""}`}
                    >
                      {estimateText(option)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

/** Where a helper's choice is saved. */
export type ThinkingTarget =
  | { readonly kind: "agent"; readonly id: Id; readonly name: string }
  | { readonly kind: "morrow"; readonly name: string }
  | { readonly kind: "specialists"; readonly name: string };
const targetId = (target: ThinkingTarget) =>
  target.kind === "agent" ? target.id : target.kind === "morrow" ? "morrow" : "specialists";

interface Resolved {
  readonly current: ThinkingChoice;
  readonly options: readonly ThinkingOption[];
  readonly canChange: boolean;
  readonly revision: number | null;
  /** The member ceiling, sent unchanged with the workspace default. */
  readonly ceiling: number | null;
  readonly dailyLimit: number | null;
}
function resolve(thinking: ThinkingView, catalogue: ModelCatalogueView | null): Resolved | null {
  if (thinking.source === "workspace_default") {
    if (catalogue === null) return null;
    return {
      current: catalogue.workspaceDefault,
      options: optionsFromCatalogue(catalogue),
      canChange: catalogue.canRevise,
      revision: catalogue.revision,
      ceiling: catalogue.ceiling,
      dailyLimit: null,
    };
  }
  return {
    current: { model: thinking.model, effort: thinking.effort },
    options: optionsFromEstimates(thinking),
    canChange: thinking.canChange,
    revision: thinking.revision,
    ceiling: null,
    dailyLimit: thinking.dailyLimit,
  };
}

/**
 * The editor inside the agent page's card and the Team page's dialog: the picker, the
 * estimate, the "doesn't fit" warning, and Save. A person who may not change it sees the
 * setting and who can.
 */
export function ThinkingEditor({
  workspaceId,
  target,
  thinking,
  ownerName,
  variant,
  onSaved,
  onStale,
  onCancel,
  onBusy,
}: {
  readonly workspaceId: Id;
  readonly target: ThinkingTarget;
  readonly thinking: ThinkingView;
  readonly ownerName: string;
  readonly variant: "card" | "dialog";
  /** A confirmed save: the parent rereads its view. */
  readonly onSaved: (choice: ThinkingChoice) => void;
  /** The record moved on (a 409): the parent rereads and the person picks again. */
  readonly onStale: () => void;
  readonly onCancel?: () => void;
  /**
   * A save (or a Check again) is in flight: the dialog around it stays open until its reply.
   * An unknown outcome doesn't hold it: its marker outlives the dialog.
   */
  readonly onBusy?: (busy: boolean) => void;
}) {
  const services = useServices();
  const bound = thinking.source === "workspace_default";
  const [models, reloadModels] = useRead(bound ? `${workspaceId}|models` : null, () =>
    services.port.models.list(workspaceId),
  );
  const resolved = resolve(thinking, models.kind === "ok" ? models.value : null);
  const [picked, setPicked] = useState<ThinkingChoice | null>(null);
  const [saved, setSaved] = useState<ThinkingChoice | null>(null);
  const currentKey = resolved ? `${resolved.current.model}|${resolved.current.effort}` : "";
  // A new current value (a reload after a save or a conflict) restarts the choice.
  useEffect(() => setPicked(null), [currentKey]);
  const value = picked ?? resolved?.current ?? null;
  const dirty = resolved !== null && value !== null && !same(value, resolved.current);
  useDirty(dirty);
  const save = useCommand<
    {
      model: string;
      effort: string;
      expectedRevision: number | null;
      maxCreditsPerProduct: number | null;
    },
    { readonly revision: number }
  >({
    marker: { workspaceId, kind: bound ? "model_default" : "thinking" },
    send: (c) => {
      const { model, effort, expectedRevision, maxCreditsPerProduct } = c.body;
      if (bound && maxCreditsPerProduct !== null)
        return services.port.models.reviseDefault(workspaceId, {
          key: c.key,
          body: { model, effort, maxCreditsPerProduct, expectedRevision },
        });
      return services.port.team.reviseThinking(workspaceId, targetId(target), {
        key: c.key,
        body: { model, effort, expectedRevision },
      });
    },
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok" || (outcome.kind === "conflict" && outcome.recheck)) {
        if (bound) reloadModels();
        if (outcome.kind === "ok") {
          setSaved({ model: sent.body.model, effort: sent.body.effort });
          onSaved({ model: sent.body.model, effort: sent.body.effort });
        } else onStale();
      }
    },
  });
  const inFlight =
    save.phase.phase === "sending" || (save.phase.phase === "uncertain" && save.phase.checking);
  useEffect(() => onBusy?.(inFlight), [inFlight, onBusy]);
  if (bound && models.kind === "loading")
    return (
      <p className="sr-help" role="status">
        {copy.states.loading}
      </p>
    );
  // A failed read of the catalogue says what failed (offline, unavailable) and offers a retry.
  if (bound && models.kind !== "ok") return outcomeState(models, reloadModels, { compact: true });
  if (!resolved || !value) return null;
  const option = find(resolved.options, value);
  const fits = option?.fits ?? false;
  const specialists = target.kind === "specialists";
  if (!resolved.canChange)
    return (
      <div className="sr-thinking-readonly">
        <dl className="sr-pairs">
          <div>
            <dt>{t.model}</dt>
            <dd>
              {modelName(resolved.current.model)}
              {sunriseCopy.models[resolved.current.model]
                ? ` · ${sunriseCopy.models[resolved.current.model]!.about}`
                : ""}
            </dd>
          </div>
          <div>
            <dt>{t.effort}</dt>
            <dd>
              {effortName(resolved.current.effort)}
              {sunriseCopy.efforts[resolved.current.effort]
                ? ` · ${sunriseCopy.efforts[resolved.current.effort]!.about}`
                : ""}
            </dd>
          </div>
        </dl>
        <p className="sr-help sr-with-icon">
          <SrIcon name="lock" size={16} />
          {/* The workspace default (the Listings agent's choice) is the Owner's alone. */}
          {target.kind === "agent" && !bound
            ? t.onlyOwnerOrAdmin(ownerName, target.name)
            : t.onlyOwner(ownerName, target.name)}
        </p>
      </div>
    );
  const choice = choiceText(value);
  const submit = () => {
    if (!fits || !dirty) return;
    void save.submit({
      model: value.model,
      effort: value.effort,
      expectedRevision: resolved.revision,
      maxCreditsPerProduct: bound ? resolved.ceiling : null,
    });
  };
  return (
    <form
      className="sr-thinking"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {variant === "dialog" ? (
        <p className="sr-help">
          {specialists
            ? t.usualSpecialists(choiceText(thinking.usual))
            : t.usual(choiceText(thinking.usual))}
        </p>
      ) : null}
      <ThinkingPicker
        value={value}
        options={resolved.options}
        onChange={(next) => {
          setSaved(null);
          setPicked(next);
        }}
        disabled={save.busy}
      />
      {fits ? (
        <p className="sr-note">
          <SrIcon name="coins" size={18} />
          <span>{t.note(choice, estimateText(option))}</span>
        </p>
      ) : (
        <div className="sr-inline-warning" role="status">
          <p className="sr-inline-warning-title">
            <SrIcon name="alert" size={18} />
            {t.overTitle(choice)}
          </p>
          <p>
            {option === null
              ? t.notOffered
              : option.unit === "product"
                ? t.overProduct(option.typical, resolved.ceiling ?? 0)
                : t.overJob(option.most ?? option.typical, resolved.dailyLimit ?? 0)}
          </p>
          {bound ? (
            <RouteLink
              route="settings_section"
              params={{ workspaceId, section: settingsRoutes.governance! }}
              className="sr-link"
            >
              {t.editLimits}
            </RouteLink>
          ) : null}
        </div>
      )}
      <p className="sr-help sr-with-icon">
        <SrIcon name="info" size={16} />
        {specialists ? t.appliesSpecialists : t.applies}
      </p>
      {dirty && fits ? (
        <p className="sr-help">
          {specialists ? t.pendingSpecialists(choice) : t.pending(target.name, choice)}
        </p>
      ) : null}
      <div className="sr-form-actions">
        {variant === "dialog" || dirty ? (
          <Button
            onClick={() => {
              setPicked(null);
              save.reset();
              onCancel?.();
            }}
            disabled={inFlight}
          >
            {t.cancel}
          </Button>
        ) : null}
        {/* One primary button per page (ADR-0032 item 2): on the agent page the card's Save
            sits beside the page's own action, so it is secondary there. */}
        <Button
          variant={variant === "dialog" ? "primary" : "secondary"}
          type="submit"
          disabled={!dirty || !fits || save.busy}
        >
          {save.busy ? t.saving : t.save}
        </Button>
      </div>
      <CommandFeedback
        phase={save.phase}
        onCheckAgain={() => void save.checkAgain()}
        onRetry={() => void save.retry()}
        {...(saved
          ? {
              success: specialists
                ? t.savedSpecialists(choiceText(saved))
                : t.saved(target.name, choiceText(saved)),
            }
          : {})}
        messages={{ conflict: (o) => (o.recheck ? t.changed : o.message) }}
      />
    </form>
  );
}

/** The Team page's "Change" dialog. */
export function ThinkingDialog({
  open,
  workspaceId,
  target,
  thinking,
  ownerName,
  onClose,
  onSaved,
  onStale,
}: {
  readonly open: boolean;
  readonly workspaceId: Id;
  readonly target: ThinkingTarget;
  readonly thinking: ThinkingView;
  readonly ownerName: string;
  readonly onClose: () => void;
  readonly onSaved: (choice: ThinkingChoice) => void;
  readonly onStale: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Dialog
      open={open}
      title={target.kind === "specialists" ? t.dialogTitleSpecialists : t.dialogTitle(target.name)}
      onClose={close}
    >
      {open ? (
        <ThinkingEditor
          workspaceId={workspaceId}
          target={target}
          thinking={thinking}
          ownerName={ownerName}
          variant="dialog"
          onCancel={close}
          onSaved={onSaved}
          onStale={onStale}
          onBusy={setBusy}
        />
      ) : null}
    </Dialog>
  );
}

/** A plain summary: "Sonnet 5.5 · Low thinking effort". */
export function ThinkingSummary({ choice }: { readonly choice: ThinkingChoice }) {
  return <>{t.long(modelName(choice.model), effortName(choice.effort))}</>;
}
