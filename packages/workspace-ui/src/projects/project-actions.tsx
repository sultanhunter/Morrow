// A project's person-only actions (ADR-0033 items 5 and 11; ADR-0034 item 8): Plan next
// steps, Stop steps, Extend and Finish. Each shows only where the server's `actions` say
// this person may act now; each sends the goal record's revision, so a project that
// changed meanwhile is a 409 that re-reads it (the next tap carries the new revision);
// and each keeps its key through an unknown outcome. Finish is the plan start over a
// code-built card: a start document, then its single use. The dialogs stay mounted while
// the page re-reads, and report success to the page, which says it in its own status
// region and moves focus to its title: the button that opened a dialog is often gone.
import { useId, useRef, useState } from "react";
import type { Id } from "../model";
import { useCommand, useServices } from "../services";
import { Button, Dialog } from "../components/controls";
import { CommandFeedback } from "../screens/entry";
import { projectsCopy } from "./copy";
import { formatDay } from "./format";
import type { ProjectDetailView } from "./model";
import { PlanStartFeedback, usePlanStart } from "./plan-start";

export function PlanNextStepsButton({
  ws,
  project,
  onAsked,
  onStale,
}: {
  readonly ws: Id;
  readonly project: ProjectDetailView;
  /** Morrow was asked: its reply comes in the conversation. */
  readonly onAsked: () => void;
  /** The project changed since it was read (a 409): re-read it and its conversation. */
  readonly onStale: () => void;
}) {
  const services = useServices();
  const c = projectsCopy.planNext;
  const command = useCommand<{ expectedRevision: number }, { readonly messageId: Id }>({
    marker: { workspaceId: ws, kind: "project" },
    send: (cmd) => services.port.projects.planNextSteps(ws, project.projectId, cmd),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onAsked();
      else if (outcome.kind === "conflict" && outcome.recheck) onStale();
    },
  });
  return (
    <div className="pj-action">
      <Button
        variant="primary"
        disabled={command.busy}
        onClick={() => void command.submit({ expectedRevision: project.revision })}
      >
        {command.busy ? c.working : projectsCopy.project.planNext}
      </Button>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        success={c.done}
        messages={{ conflict: () => c.changed }}
      />
    </div>
  );
}

/** What each project dialog is given by the page. */
interface ProjectDialogProps {
  readonly ws: Id;
  readonly project: ProjectDetailView;
  readonly open: boolean;
  /** Whether the server's `actions` (and the switch) allow the act now; the server checks again. */
  readonly allowed: boolean;
  readonly onClose: () => void;
  /** Confirmed: the page closes the dialog, says `message`, moves focus and re-reads. */
  readonly onDone: (message: string) => void;
  /** The project changed since it was read (a 409): the page re-reads; the dialog stays. */
  readonly onStale: () => void;
}

export function StopStepsDialog({
  ws,
  project,
  open,
  allowed,
  onClose,
  onDone,
  onStale,
}: ProjectDialogProps) {
  const services = useServices();
  const c = projectsCopy.stop;
  const command = useCommand<
    { expectedRevision: number },
    { readonly turnedOff: number; readonly cancelled: number }
  >({
    marker: { workspaceId: ws, kind: "project" },
    send: (cmd) => services.port.projects.stopSteps(ws, project.projectId, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok") {
        if (sent.current) onClose();
        onDone(c.done(outcome.value.turnedOff, outcome.value.cancelled));
      } else if (outcome.kind === "conflict" && outcome.recheck) onStale();
    },
  });
  const close = () => {
    if (command.busy) return;
    command.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={c.title}
      onClose={close}
      footer={
        <>
          <Button data-initial-focus onClick={close} disabled={command.busy}>
            {c.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={command.busy || !allowed}
            onClick={() => void command.submit({ expectedRevision: project.revision })}
          >
            {command.busy ? c.working : c.confirm}
          </Button>
        </>
      }
    >
      <p>{c.body}</p>
      {project.stopPreview ? <p dir="auto">{c.here(project.stopPreview)}</p> : null}
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        messages={{ conflict: () => c.changed }}
      />
    </Dialog>
  );
}

export function ExtendDialog({
  ws,
  project,
  open,
  allowed,
  onClose,
  onDone,
  onStale,
}: ProjectDialogProps) {
  const services = useServices();
  const c = projectsCopy.extend;
  // The day this dialog offered, kept for its title while a re-read has none to offer.
  const offered = useRef(project.extendTo);
  if (project.extendTo !== null) offered.current = project.extendTo;
  const shown = offered.current;
  const extendTo = project.extendTo;
  const command = useCommand<
    { endsOn: string; expectedRevision: number },
    { readonly revision: number }
  >({
    marker: { workspaceId: ws, kind: "project" },
    send: (cmd) => services.port.projects.extend(ws, project.projectId, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok") {
        if (sent.current) onClose();
        onDone(c.done(formatDay(sent.body.endsOn)));
      } else if (outcome.kind === "conflict" && outcome.recheck) onStale();
    },
  });
  const close = () => {
    if (command.busy) return;
    command.reset();
    onClose();
  };
  if (shown === null) return null;
  return (
    <Dialog
      open={open}
      title={c.title(formatDay(shown))}
      onClose={close}
      footer={
        <>
          <Button data-initial-focus onClick={close} disabled={command.busy}>
            {c.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={command.busy || !allowed || extendTo === null}
            onClick={() => {
              if (extendTo !== null)
                void command.submit({ endsOn: extendTo, expectedRevision: project.revision });
            }}
          >
            {command.busy ? c.working : c.confirm}
          </Button>
        </>
      }
    >
      <p>{c.body}</p>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        messages={{ conflict: () => c.changed }}
      />
    </Dialog>
  );
}

export function FinishDialog({
  ws,
  project,
  open,
  allowed,
  onClose,
  onDone,
  onStale,
}: ProjectDialogProps) {
  const services = useServices();
  const c = projectsCopy.finish;
  const choice = project.finish;
  const [keep, setKeep] = useState(choice?.keepByDefault ?? false);
  const keepId = useId();
  const flow = usePlanStart<{ keepRepeating: boolean; expectedRevision: number }>({
    ws,
    request: (cmd) => services.port.projects.finishDocument(ws, project.projectId, cmd),
    expected: { target: "finish", draftDigest: null, projectId: project.projectId },
    onStarted: () => {
      onClose();
      onDone(c.done);
    },
    onStale,
  });
  const close = () => {
    if (flow.busy) return;
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={c.title(project.title)}
      onClose={close}
      footer={
        <>
          <Button data-initial-focus onClick={close} disabled={flow.busy}>
            {c.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={flow.busy || !allowed}
            onClick={() =>
              flow.begin({
                keepRepeating: choice !== null && keep,
                expectedRevision: project.revision,
              })
            }
          >
            {flow.busy ? c.working : c.confirm}
          </Button>
        </>
      }
    >
      <p>{c.body}</p>
      {choice ? (
        <div className="pj-check-group">
          <label className="pj-check">
            <input
              type="checkbox"
              checked={keep}
              disabled={flow.busy}
              aria-describedby={keepId + "-note"}
              onChange={(event) => setKeep(event.target.checked)}
            />
            <span dir="auto">{choice.keepLabel}</span>
          </label>
          <p id={keepId + "-note"} className="pj-meta" dir="auto">
            {choice.keepNote}
          </p>
        </div>
      ) : null}
      <PlanStartFeedback flow={flow} changed={c.changed} />
    </Dialog>
  );
}
