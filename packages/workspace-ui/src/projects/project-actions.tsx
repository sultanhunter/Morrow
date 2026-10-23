// A project's person-only actions (ADR-0033 items 5 and 11; ADR-0034 item 8): Plan next
// steps, Stop steps, Extend and Finish. Each shows only where the server's `actions` say
// this person may act now; each sends the goal record's revision, so a project that
// changed meanwhile is a 409 that re-reads it; and each keeps its key through an unknown
// outcome. Finish is the plan start over a code-built card: a start document, then its
// single use.
import { useId, useState } from "react";
import type { Id } from "../model";
import { useCommand, useServices } from "../services";
import { Button, Dialog } from "../components/controls";
import { StatusRegion } from "../components/feedback";
import { CommandFeedback } from "../screens/entry";
import { projectsCopy } from "./copy";
import { formatDay } from "./format";
import type { ProjectDetailView } from "./model";
import { PlanStartFeedback, usePlanStart } from "./plan-start";

export function PlanNextStepsButton({
  ws,
  project,
  onAsked,
}: {
  readonly ws: Id;
  readonly project: ProjectDetailView;
  readonly onAsked: () => void;
}) {
  const services = useServices();
  const c = projectsCopy.planNext;
  const command = useCommand<{ expectedRevision: number }, { readonly messageId: Id }>({
    marker: { workspaceId: ws, kind: "project" },
    send: (cmd) => services.port.projects.planNextSteps(ws, project.projectId, cmd),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok" || (outcome.kind === "conflict" && outcome.recheck)) onAsked();
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

export function StopStepsDialog({
  ws,
  project,
  open,
  onClose,
  onStopped,
}: {
  readonly ws: Id;
  readonly project: ProjectDetailView;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onStopped: () => void;
}) {
  const services = useServices();
  const c = projectsCopy.stop;
  const [done, setDone] = useState<string | null>(null);
  const command = useCommand<
    { expectedRevision: number },
    { readonly turnedOff: number; readonly cancelled: number }
  >({
    marker: { workspaceId: ws, kind: "project" },
    send: (cmd) => services.port.projects.stopSteps(ws, project.projectId, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok") {
        setDone(c.done(outcome.value.turnedOff, outcome.value.cancelled));
        if (sent.current) onClose();
        onStopped();
      } else if (outcome.kind === "conflict" && outcome.recheck) onStopped();
    },
  });
  const close = () => {
    if (command.busy) return;
    command.reset();
    onClose();
  };
  return (
    <>
      <StatusRegion message={done} />
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
              disabled={command.busy}
              onClick={() => {
                setDone(null);
                void command.submit({ expectedRevision: project.revision });
              }}
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
    </>
  );
}

export function ExtendDialog({
  ws,
  project,
  open,
  onClose,
  onExtended,
}: {
  readonly ws: Id;
  readonly project: ProjectDetailView;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onExtended: () => void;
}) {
  const services = useServices();
  const c = projectsCopy.extend;
  const [done, setDone] = useState<string | null>(null);
  const extendTo = project.extendTo;
  const command = useCommand<
    { endsOn: string; expectedRevision: number },
    { readonly revision: number }
  >({
    marker: { workspaceId: ws, kind: "project" },
    send: (cmd) => services.port.projects.extend(ws, project.projectId, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok") {
        setDone(c.done(formatDay(sent.body.endsOn)));
        if (sent.current) onClose();
        onExtended();
      } else if (outcome.kind === "conflict" && outcome.recheck) onExtended();
    },
  });
  const close = () => {
    if (command.busy) return;
    command.reset();
    onClose();
  };
  if (extendTo === null) return null;
  return (
    <>
      <StatusRegion message={done} />
      <Dialog
        open={open}
        title={c.title(formatDay(extendTo))}
        onClose={close}
        footer={
          <>
            <Button data-initial-focus onClick={close} disabled={command.busy}>
              {c.cancel}
            </Button>
            <Button
              variant="primary"
              disabled={command.busy}
              onClick={() => {
                setDone(null);
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
    </>
  );
}

export function FinishDialog({
  ws,
  project,
  open,
  onClose,
  onFinished,
}: {
  readonly ws: Id;
  readonly project: ProjectDetailView;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onFinished: () => void;
}) {
  const services = useServices();
  const c = projectsCopy.finish;
  const choice = project.finish;
  const [keep, setKeep] = useState(choice?.keepByDefault ?? false);
  const [done, setDone] = useState<string | null>(null);
  const keepId = useId();
  const flow = usePlanStart<{ keepRepeating: boolean; expectedRevision: number }>({
    ws,
    request: (cmd) => services.port.projects.finishDocument(ws, project.projectId, cmd),
    expected: { target: "finish", draftDigest: null, projectId: project.projectId },
    onStarted: () => {
      setDone(c.done);
      onClose();
      onFinished();
    },
    onStale: onFinished,
  });
  const close = () => {
    if (flow.busy) return;
    onClose();
  };
  return (
    <>
      <StatusRegion message={done} />
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
              disabled={flow.busy}
              onClick={() => {
                setDone(null);
                flow.begin({
                  keepRepeating: choice !== null && keep,
                  expectedRevision: project.revision,
                });
              }}
            >
              {flow.busy ? c.working : c.confirm}
            </Button>
          </>
        }
      >
        <p>{c.body}</p>
        {choice ? (
          <div className="pj-check">
            <input
              id={keepId}
              type="checkbox"
              checked={keep}
              disabled={flow.busy}
              aria-describedby={keepId + "-note"}
              onChange={(event) => setKeep(event.target.checked)}
            />
            <label htmlFor={keepId} dir="auto">
              {choice.keepLabel}
            </label>
            <p id={keepId + "-note"} className="pj-meta" dir="auto">
              {choice.keepNote}
            </p>
          </div>
        ) : null}
        <PlanStartFeedback flow={flow} />
      </Dialog>
    </>
  );
}
