// T7 PR 16: simple Shop knowledge and Files pages. PR 20 (shop knowledge): a person adds,
// edits and deletes pages (typed text only, never customer details) and accepts or declines
// agents' suggested notes, each bound to what the person saw (its version or digest). The
// HTTP build composes these methods only when the shop-knowledge switch goes on; until then
// the screen reads its fixtures and nothing is sent. Uploads wait for their deletion path
// (P09.T05), so "Upload a file" is marked "Coming soon" and nothing is sent.
import { useId, useState, type FormEvent } from "react";
import { outcomeState } from "../components/feedback";
import { Button, Dialog, TextArea, TextField } from "../components/controls";
import type { WorkspaceView } from "../model";
import { useCommand, useRead, useServices } from "../services";
import {
  knowledgePageKinds,
  type FilesView,
  type KnowledgeItemView,
  type KnowledgePageKind,
  type KnowledgeView,
} from "../team-model";
import { AgentAvatar, PersonAvatar } from "../sunrise/avatars";
import { sunriseCopy } from "../sunrise/copy";
import { Card, ComingSoon, PageHeader, SrIcon, SrTabs } from "../sunrise/parts";
import { CommandFeedback } from "./entry";

const k = sunriseCopy.knowledge;
type Kind = KnowledgeView["items"][number]["kind"];
const kinds: readonly Kind[] = ["fact", "suggested", "lesson"];
const limits = Object.freeze({ title: 120, text: 8000, note: 200 });
const textValid = (value: string, max: number) =>
  value.trim() !== "" && [...value].length <= max && !value.includes("\0");

type Editing =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly item: KnowledgeItemView }
  | null;

/** Add a page, or the next version of one (the version the person read). */
function KnowledgeDialog({
  workspaceId,
  editing,
  existingBrandVoice,
  onClose,
  onSaved,
}: {
  readonly workspaceId: string;
  readonly editing: Exclude<Editing, null>;
  readonly existingBrandVoice: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const services = useServices();
  const ws = workspaceId;
  const item = editing.mode === "edit" ? editing.item : null;
  const [page, reloadPage] = useRead(`${ws}|library.knowledgePage|${item?.id ?? "new"}`, () =>
    item
      ? services.port.library.knowledgePage(ws, item.id)
      : Promise.resolve({ kind: "not_found" as const }),
  );
  const loaded = page.kind === "ok" ? page.value : null;
  const firstKind: KnowledgePageKind = existingBrandVoice ? "policy" : "brand_voice";
  const [draft, setDraft] = useState<{
    pageKind: KnowledgePageKind;
    title: string;
    text: string;
    note: string;
  } | null>(null);
  const current = draft ?? {
    pageKind: loaded?.pageKind ?? firstKind,
    title: loaded?.title ?? "",
    text: loaded?.text ?? "",
    note: loaded?.note ?? "",
  };
  const set = (patch: Partial<typeof current>) => setDraft({ ...current, ...patch });
  const [checked, setChecked] = useState(false);
  const command = useCommand<
    {
      pageKind: KnowledgePageKind;
      title: string;
      text: string;
      note: string;
      expectedVersion: number | null;
    },
    unknown
  >({
    marker: { workspaceId: ws, kind: "knowledge" },
    send: (c) => {
      const { pageKind, title, text, note, expectedVersion } = c.body;
      if (item === null || expectedVersion === null)
        return services.port.library.addKnowledge(ws, {
          key: c.key,
          body: { pageKind, title, text, note },
        });
      return services.port.library.editKnowledge(ws, item.id, {
        key: c.key,
        body: { title, text, note, expectedVersion },
      });
    },
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok" && sent.current) {
        onSaved();
        onClose();
      }
    },
  });
  const formId = useId();
  const selectId = useId();
  const valid =
    textValid(current.title, limits.title) &&
    textValid(current.text, limits.text) &&
    (current.note === "" || textValid(current.note, limits.note)) &&
    (item !== null || !(current.pageKind === "brand_voice" && existingBrandVoice));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid || command.busy || (item && !loaded)) return;
    void command.submit({
      pageKind: current.pageKind,
      title: current.title.trim(),
      text: current.text.trim(),
      note: current.note.trim(),
      expectedVersion: item ? (loaded?.version ?? null) : null,
    });
  };
  const close = () => {
    if (command.busy) return;
    command.reset();
    onClose();
  };
  return (
    <Dialog
      open
      title={item ? k.editTitle(item.title) : k.addTitle}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={command.busy}>
            {k.cancel}
          </Button>
          <Button type="submit" variant="primary" form={formId} disabled={command.busy}>
            {k.save}
          </Button>
        </>
      }
    >
      {item && page.kind !== "ok" ? (
        outcomeState(page, reloadPage)
      ) : (
        <form id={formId} onSubmit={submit} noValidate className="pj-form">
          <p className="sr-help sr-with-icon">
            <SrIcon name="lock" size={16} />
            {k.typedOnly}
          </p>
          {item === null ? (
            <div className="field">
              <label htmlFor={selectId}>{k.kindLabel}</label>
              <select
                id={selectId}
                value={current.pageKind}
                disabled={command.busy}
                aria-describedby={selectId + "-hint"}
                onChange={(event) =>
                  set({
                    pageKind: knowledgePageKinds.find((x) => x === event.target.value) ?? firstKind,
                  })
                }
              >
                {knowledgePageKinds
                  .filter((x) => !(x === "brand_voice" && existingBrandVoice))
                  .map((x) => (
                    <option key={x} value={x}>
                      {k.pageKinds[x]}
                    </option>
                  ))}
              </select>
              <small id={selectId + "-hint"}>{k.brandVoiceHelp}</small>
            </div>
          ) : null}
          <TextField
            label={k.titleLabel}
            value={current.title}
            onChange={(title) => set({ title })}
            error={checked && !textValid(current.title, limits.title) ? copyInvalid : null}
            disabled={command.busy}
            maxLength={limits.title}
            required
          />
          <TextArea
            label={k.textLabel}
            value={current.text}
            onChange={(text) => set({ text })}
            error={checked && !textValid(current.text, limits.text) ? copyInvalid : null}
            disabled={command.busy}
            maxLength={limits.text}
            required
          />
          <TextField
            label={k.noteLabel}
            value={current.note}
            onChange={(note) => set({ note })}
            hint={k.noteHelp}
            disabled={command.busy}
            maxLength={limits.note}
          />
          <CommandFeedback
            phase={command.phase}
            onCheckAgain={command.checkAgain}
            onRetry={command.retry}
            success={k.saved}
            messages={{ conflict: () => k.changed }}
          />
        </form>
      )}
    </Dialog>
  );
}
const copyInvalid = k.invalid;

/** Deletes a page and all its versions, at the version the person read. */
function DeleteDialog({
  workspaceId,
  item,
  onClose,
  onDeleted,
}: {
  readonly workspaceId: string;
  readonly item: KnowledgeItemView;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const services = useServices();
  const command = useCommand<{ expectedVersion: number }, unknown>({
    marker: { workspaceId, kind: "knowledge" },
    send: (c) => services.port.library.deleteKnowledge(workspaceId, item.id, c),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok" && sent.current) {
        onDeleted();
        onClose();
      }
    },
  });
  const close = () => {
    if (command.busy) return;
    command.reset();
    onClose();
  };
  return (
    <Dialog
      open
      title={k.removeTitle}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={command.busy}>
            {k.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={command.busy || item.version === null}
            onClick={() => void command.submit({ expectedVersion: item.version ?? 0 })}
          >
            {k.removeConfirm}
          </Button>
        </>
      }
    >
      <p dir="auto">{k.removeBody(item.title)}</p>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        success={k.removed}
        messages={{ conflict: () => k.changed }}
      />
    </Dialog>
  );
}

/** Accept or decline one suggested note, bound to the digest the person saw. */
function SuggestionActions({
  workspaceId,
  item,
  onDecided,
}: {
  readonly workspaceId: string;
  readonly item: KnowledgeItemView;
  readonly onDecided: () => void;
}) {
  const services = useServices();
  const command = useCommand<{ decision: "accept" | "reject"; digest: string }, unknown>({
    marker: { workspaceId, kind: "knowledge" },
    send: (c) => services.port.library.decideSuggestion(workspaceId, item.id, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok" || (outcome.kind === "conflict" && outcome.recheck)) onDecided();
    },
  });
  const decide = (decision: "accept" | "reject") =>
    item.digest ? void command.submit({ decision, digest: item.digest }) : undefined;
  return (
    <div className="sr-list-text">
      <div className="sr-actions">
        <Button
          variant="primary"
          aria-label={k.accept(item.title)}
          disabled={command.busy || item.digest === null}
          onClick={() => decide("accept")}
        >
          {k.acceptLabel}
        </Button>
        <Button
          aria-label={k.reject(item.title)}
          disabled={command.busy || item.digest === null}
          onClick={() => decide("reject")}
        >
          {k.rejectLabel}
        </Button>
      </div>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        success={
          command.phase.phase === "settled" &&
          command.phase.outcome.kind === "ok" &&
          (command.phase.outcome.value as { decision?: string }).decision === "reject"
            ? k.rejected
            : k.accepted
        }
        messages={{ conflict: () => k.changed }}
      />
    </div>
  );
}

function KnowledgeBody({
  workspaceId,
  view,
  reload,
}: {
  readonly workspaceId: string;
  readonly view: KnowledgeView;
  readonly reload: () => void;
}) {
  const [kind, setKind] = useState<Kind>("fact");
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<KnowledgeItemView | null>(null);
  const items = view.items.filter((i) => i.kind === kind);
  const existingBrandVoice = view.items.some(
    (i) => i.kind === "fact" && i.pageKind === "brand_voice",
  );
  return (
    <>
      <p className="sr-help sr-with-icon">
        <SrIcon name="lock" size={16} />
        {k.typedOnly}
      </p>
      {view.may.write ? (
        <div className="sr-actions">
          <Button variant="primary" onClick={() => setEditing({ mode: "add" })}>
            <SrIcon name="plus" />
            {k.add}
          </Button>
        </div>
      ) : null}
      <SrTabs
        label={k.tabs}
        idPrefix="knowledge"
        tabs={kinds.map((id) => ({
          id,
          label: k.kinds[id],
          count: view.items.filter((i) => i.kind === id).length,
        }))}
        selected={kind}
        onSelect={(id) => setKind(kinds.find((x) => x === id) ?? "fact")}
      />
      <div id={`knowledge-panel-${kind}`} role="tabpanel" aria-labelledby={`knowledge-tab-${kind}`}>
        <Card title={k.kinds[kind]} flush>
          {items.length === 0 ? (
            <div className="sr-empty">
              <SrIcon name="book" size={32} />
              <p className="sr-empty-body">{k.empty[kind]}</p>
            </div>
          ) : (
            <ul className="sr-rows">
              {items.map((item) => (
                <li key={item.id} className="sr-list-row">
                  <SrIcon
                    name={kind === "fact" ? "book" : kind === "suggested" ? "idea" : "check"}
                  />
                  <div className="sr-list-text">
                    <p className="sr-row-title" dir="auto">
                      {item.title}
                    </p>
                    <p className="sr-reading" dir="auto">
                      {item.text}
                    </p>
                    <p className="sr-meta" dir="auto">
                      {[
                        item.pageKind ? k.pageKinds[item.pageKind] : null,
                        kind === "fact" && item.version !== null ? k.version(item.version) : null,
                        kind === "suggested" && item.pageKind !== null && item.version === null
                          ? k.newPage
                          : null,
                        item.source,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {kind === "suggested" && item.untrusted ? (
                      <p className="sr-meta sr-with-icon">
                        <SrIcon name="alert" size={16} />
                        {k.untrusted}
                      </p>
                    ) : null}
                    {kind === "suggested" && view.may.write ? (
                      <SuggestionActions workspaceId={workspaceId} item={item} onDecided={reload} />
                    ) : null}
                    {kind === "fact" && (view.may.write || view.may.delete) ? (
                      <div className="sr-actions">
                        {view.may.write ? (
                          <Button
                            aria-label={k.edit(item.title)}
                            onClick={() => setEditing({ mode: "edit", item })}
                          >
                            {k.editLabel}
                          </Button>
                        ) : null}
                        {view.may.delete ? (
                          <Button
                            aria-label={k.remove(item.title)}
                            onClick={() => setDeleting(item)}
                          >
                            {k.removeConfirm}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="sr-help sr-with-icon">
        <SrIcon name="clock" size={16} />
        {k.later}
      </p>
      {editing ? (
        <KnowledgeDialog
          workspaceId={workspaceId}
          editing={editing}
          existingBrandVoice={existingBrandVoice}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          workspaceId={workspaceId}
          item={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={reload}
        />
      ) : null}
    </>
  );
}

export function ShopKnowledgeScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [knowledge, reload] = useRead(`${ws}|library.knowledge`, () =>
    services.port.library.knowledge(ws),
  );
  return (
    <div className="sr">
      <PageHeader workspaceId={ws} title={k.title} scope={k.intro} />
      {knowledge.kind === "ok" ? (
        <KnowledgeBody workspaceId={ws} view={knowledge.value} reload={reload} />
      ) : (
        outcomeState(knowledge, reload)
      )}
    </div>
  );
}

const f = sunriseCopy.files;
function FilesBody({ view }: { readonly view: FilesView }) {
  if (view.files.length === 0)
    return (
      <Card title={f.title}>
        <div className="sr-empty">
          <SrIcon name="file" size={32} />
          <h3 className="sr-empty-title">{f.empty}</h3>
          <p className="sr-empty-body">{f.emptyBody}</p>
        </div>
      </Card>
    );
  return (
    <Card title={f.title} flush>
      <div className="sr-table-scroll" role="region" aria-label={f.title} tabIndex={0}>
        <table className="sr-table">
          <thead>
            <tr>
              <th scope="col">{f.columns.name}</th>
              <th scope="col">{f.columns.from}</th>
              <th scope="col">{f.columns.where}</th>
              <th scope="col">{f.columns.date}</th>
              <th scope="col" className="sr-num">
                {f.columns.size}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.files.map((file) => (
              <tr key={file.id}>
                <th scope="row">
                  <span className="sr-owner-cell">
                    <span className="sr-file-type">
                      <SrIcon name="file" />
                    </span>
                    <span>
                      <span className="sr-row-title sr-block" dir="auto">
                        {file.name}
                      </span>
                      <span className="sr-meta sr-block">{f.types[file.type]}</span>
                    </span>
                  </span>
                </th>
                <td>
                  <span className="sr-owner-cell">
                    {file.character ? (
                      <AgentAvatar character={file.character} size={28} />
                    ) : (
                      <PersonAvatar
                        initials={file.from
                          .split(" ")
                          .map((w) => w.slice(0, 1))
                          .join("")
                          .slice(0, 2)}
                        size={28}
                      />
                    )}
                    <span dir="auto">{file.from}</span>
                  </span>
                </td>
                <td dir="auto">{file.where}</td>
                <td>{file.date}</td>
                <td className="sr-num">{file.size}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function FilesScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [files, reload] = useRead(`${ws}|library.files`, () => services.port.library.files(ws));
  return (
    <div className="sr">
      <PageHeader
        workspaceId={ws}
        title={f.title}
        scope={f.intro}
        actions={<ComingSoon label={f.upload} />}
      />
      <p className="sr-help sr-with-icon">
        <SrIcon name="upload" size={16} />
        {f.uploadLater}
      </p>
      {files.kind === "ok" ? <FilesBody view={files.value} /> : outcomeState(files, reload)}
    </div>
  );
}
