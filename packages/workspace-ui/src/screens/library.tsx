// T7 PR 16: simple Shop knowledge and Files pages. Read-only: adding and editing knowledge
// come with PR 20, and uploads wait for their deletion path (P09.T05), so "Upload a file"
// is marked "Coming soon" and nothing is sent. Fixture data only in this build.
import { useState } from "react";
import { outcomeState } from "../components/feedback";
import type { WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import type { FilesView, KnowledgeView } from "../team-model";
import { AgentAvatar, PersonAvatar } from "../sunrise/avatars";
import { sunriseCopy } from "../sunrise/copy";
import { Card, ComingSoon, PageHeader, SrIcon, SrTabs } from "../sunrise/parts";

const k = sunriseCopy.knowledge;
type Kind = KnowledgeView["items"][number]["kind"];
const kinds: readonly Kind[] = ["fact", "suggested", "lesson"];

function KnowledgeBody({ view }: { readonly view: KnowledgeView }) {
  const [kind, setKind] = useState<Kind>("fact");
  const items = view.items.filter((i) => i.kind === kind);
  return (
    <>
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
                      {item.source}
                    </p>
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
        <KnowledgeBody view={knowledge.value} />
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
