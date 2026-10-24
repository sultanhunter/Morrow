// The HTTP adapter of WorkspacePort (P14.T01a §4.2, §4.7). Request construction is
// closed: ids are validated against the Id pattern and inserted unencoded (the guards
// match the raw pathname, so `%3A` would 404), the only query parameters are the
// documented ones, bodies are closed literals with no organization, workspace or
// principal key, and byte limits are checked before anything is sent.
import {
  knowledgePageKinds,
  type KnowledgeContent,
  type KnowledgePageKind,
} from "@morrow/workspace-ui";
import type {
  Command,
  Composed,
  Outcome,
  PortMethod,
  RecordRefView,
  ReviewDecisionBody,
  WorkspacePort,
} from "@morrow/workspace-ui";
import {
  byteLength,
  isChallengeToken,
  isCommandKey,
  isCsrfValue,
  isId,
  type Client,
} from "./client";
import {
  decodeConnections,
  decodeStoreLinkPreview,
  decodeStoreLinkResult,
} from "./connection-decoders";
import { decodeDisconnectResult, decodeDisconnectStatus } from "./disconnect-decoders";
import {
  decodeKnowledgeDeleted,
  decodeKnowledgePage,
  decodeKnowledgePages,
  decodeKnowledgeProposals,
  decodeKnowledgeWritten,
  decodeSuggestionDecided,
} from "./knowledge-decoders";
import { handoffTokenPattern } from "../handoff";
import {
  decodeAccountOverview,
  decodeBootstrap,
  decodeLoginStart,
  decodeLogout,
  decodeOrganizationSignup,
  identityOutcome,
} from "./identity-decoders";
import {
  decodeAnswer,
  decodeAnswered,
  decodeErrorEnvelope,
  decodeGoal,
  decodeGoalCreated,
  decodeOne,
  decodePage,
  decodeQuestion,
  decodeQuestionCreated,
  decodeRevision,
  decodeTask,
  decodeTaskCreated,
  workOutcome,
} from "./work-decoders";
import {
  decodeListingsChange,
  decodeListingsDocument,
  decodeListingsStatus,
  decodeModelDefaultRevised,
  decodeModels,
  isModelKey,
} from "./agents-decoders";
import {
  decodeReconciled,
  decodeRunAdmitted,
  decodeRunDetail,
  decodeRunsOfTask,
} from "./runs-decoders";
import {
  decodeApplied,
  decodeDecided,
  decodeOperationsOfTask,
  decodePendingApprovals,
  decodeRechecked,
  decodeSetAside,
  decodeReview,
} from "./review-decoders";

export type HttpRequest =
  | { readonly method: "GET"; readonly path: string }
  | {
      readonly method: "POST";
      readonly path: string;
      readonly body: string;
      readonly key: string | null;
      /** P05.T01ab: the X-Morrow-Challenge token, on login start and signup only. */
      readonly challenge?: string;
      /** M2 PR-2: the X-Morrow-CSRF value, on the store-link apply only. */
      readonly csrf?: string;
    }
  | { readonly method: "PUT"; readonly path: string; readonly body: string; readonly key: string };
export const byteLimits = Object.freeze({ login: 512, signup: 2048, work: 65536, link: 256 });

const workPath = (ws: string, ...parts: string[]) => `/workspace/${ws}/work/${parts.join("/")}`;
const query = (pairs: readonly (readonly [string, string | null])[]) => {
  const present = pairs.filter((pair): pair is readonly [string, string] => pair[1] !== null);
  return present.length
    ? "?" + present.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
    : "";
};
const get = (path: string): HttpRequest => ({ method: "GET", path });
type PostRequest = Extract<HttpRequest, { readonly method: "POST" }>;
function post(path: string, body: unknown, key: string | null, limit: number): PostRequest | null {
  if (key !== null && !isCommandKey(key)) return null;
  const text = JSON.stringify(body);
  if (byteLength(text) > limit) return null;
  return { method: "POST", path, body: text, key };
}
const ids = (...values: unknown[]) => values.every(isId);
// M3 PR-1: the agents routes, beside the work API under /workspace/:ws (never /work).
const agentsPath = (ws: string, storeId: string, ...parts: string[]) =>
  [`/workspace/${ws}/stores/${storeId}/agents/listings`, ...parts].join("/");
const hex64 = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const stopReason = (value: unknown) =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 1024 &&
  /\S/.test(value) &&
  !value.includes("\0");
const cursor = (after: string | null) =>
  after === null || (after.length >= 1 && after.length <= 1024);
const revision = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length >= 1 && value.length <= max && !value.includes("\0");
// M3 PR-2: a run's products, fields and run id as the runs routes accept them.
const runIdPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const runProducts = (value: unknown) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 25 &&
  value.every((p) => typeof p === "string" && /^product:[1-9][0-9]{0,19}$/.test(p)) &&
  new Set(value).size === value.length;
const listingFieldPaths = ["descriptionHtml", "seo.description", "seo.title", "tags", "title"];
const runFields = (value: unknown) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 5 &&
  value.every((f) => typeof f === "string" && listingFieldPaths.includes(f)) &&
  new Set(value).size === value.length &&
  value.includes("seo.title") === value.includes("seo.description");

// v1 PR 3: a selection of a proposal's products (root indexes), and the refs the review
// read returned, sent back exactly.
const selection = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 100 &&
  value.every((i) => Number.isSafeInteger(i) && i >= 0 && i <= 99) &&
  new Set(value).size === value.length;
const refOf = (value: RecordRefView, kind: "proposal" | "approval") =>
  value !== null &&
  typeof value === "object" &&
  Object.keys(value).sort().join() ===
    "digest,id,kind,organizationId,revision,storeId,workspaceId" &&
  value.kind === kind &&
  isId(value.organizationId) &&
  isId(value.workspaceId) &&
  (value.storeId === null || isId(value.storeId)) &&
  isId(value.id) &&
  revision(value.revision) &&
  hex64(value.digest)
    ? {
        organizationId: value.organizationId,
        workspaceId: value.workspaceId,
        storeId: value.storeId,
        kind,
        id: value.id,
        revision: value.revision,
        digest: value.digest,
      }
    : null;
const operationIdPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// PR 20: a knowledge page's typed text (the server's KnowledgeTitle and KnowledgeText) and its
// one optional note, sent as the version's only source.
const knowledgeContent = (b: KnowledgeContent) =>
  text(b.title, 120) &&
  /\S/.test(b.title) &&
  text(b.text, 8000) &&
  /\S/.test(b.text) &&
  (b.note === "" || (text(b.note, 200) && /\S/.test(b.note)));
const noteSources = (note: string) => (note === "" ? [] : [{ kind: "note", value: note }]);

/** Every request this adapter can send; `null` means refused before sending. */
export const requests = {
  login(
    version: 1 | 2,
    workspaceId: string | null,
    challenge: string | null = null,
  ): HttpRequest | null {
    if (challenge !== null && !isChallengeToken(challenge)) return null;
    if (version === 1 && !isId(workspaceId)) return null;
    const body = version === 2 ? { schemaVersion: 2 } : { schemaVersion: 1, workspaceId };
    const request = post("/auth/login", body, null, byteLimits.login);
    return request && challenge !== null ? { ...request, challenge } : request;
  },
  logout: (): HttpRequest => post("/auth/logout", { schemaVersion: 1 }, null, byteLimits.login)!,
  bootstrap: (ws: string) => (isId(ws) ? get(`/workspace/${ws}/bootstrap`) : null),
  overview: () => get("/workspaces"),
  createOrganization(
    c: Command<{ organizationName: string; workspaceName: string }>,
    challenge: string | null = null,
  ): HttpRequest | null {
    if (challenge !== null && !isChallengeToken(challenge)) return null;
    const { organizationName, workspaceName } = c.body;
    if (!text(organizationName, 400) || !text(workspaceName, 400)) return null;
    const request = post(
      "/organizations",
      { schemaVersion: 1, organizationName, workspaceName },
      c.key,
      byteLimits.signup,
    );
    return request && challenge !== null ? { ...request, challenge } : request;
  },
  listGoals: (ws: string, after: string | null) =>
    ids(ws) && cursor(after)
      ? get(
          workPath(ws, "goals") +
            query([
              ["limit", "25"],
              ["after", after],
            ]),
        )
      : null,
  getGoal: (ws: string, id: string) => (ids(ws, id) ? get(workPath(ws, "goals", id)) : null),
  createGoal(ws: string, c: Command<{ objective: string; criteria: readonly string[] }>) {
    const { objective, criteria } = c.body;
    if (!ids(ws) || !text(objective, 8192) || !Array.isArray(criteria)) return null;
    if (criteria.length < 1 || criteria.length > 20 || !criteria.every((d) => text(d, 2048)))
      return null;
    const successCriteria = criteria.map((description) => ({
      description,
      verificationCapabilityId: null,
      evidenceRequired: false,
    }));
    return post(
      workPath(ws, "goals"),
      { objective, storeIds: [], successCriteria },
      c.key,
      byteLimits.work,
    );
  },
  listTasks: (ws: string, goalId: string, after: string | null) =>
    ids(ws, goalId) && cursor(after)
      ? get(
          workPath(ws, "tasks") +
            query([
              ["goalId", goalId],
              ["limit", "50"],
              ["after", after],
            ]),
        )
      : null,
  getTask: (ws: string, id: string) => (ids(ws, id) ? get(workPath(ws, "tasks", id)) : null),
  createTask(ws: string, c: Command<{ goalId: string; objective: string }>) {
    const { goalId, objective } = c.body;
    if (!ids(ws, goalId) || !text(objective, 8192)) return null;
    return post(
      workPath(ws, "tasks"),
      { goalId, objective, allowedResources: [] },
      c.key,
      byteLimits.work,
    );
  },
  markReady(ws: string, id: string, c: Command<{ expectedRevision: number }>) {
    if (!ids(ws, id) || !revision(c.body.expectedRevision)) return null;
    return post(
      workPath(ws, "tasks", id, "status"),
      { to: "ready", expectedRevision: c.body.expectedRevision },
      c.key,
      byteLimits.work,
    );
  },
  assign(ws: string, id: string, c: Command<{ assigneeId: string; expectedRevision: number }>) {
    const { assigneeId, expectedRevision } = c.body;
    if (!ids(ws, id, assigneeId) || !revision(expectedRevision)) return null;
    return post(
      workPath(ws, "tasks", id, "assignment"),
      { assigneeId, expectedRevision },
      c.key,
      byteLimits.work,
    );
  },
  listTaskQuestions: (ws: string, taskId: string, after: string | null) =>
    ids(ws, taskId) && cursor(after)
      ? get(
          workPath(ws, "tasks", taskId, "questions") +
            query([
              ["limit", "50"],
              ["after", after],
            ]),
        )
      : null,
  ask(ws: string, taskId: string, c: Command<{ question: string; respondentId: string }>) {
    const { question, respondentId } = c.body;
    if (!ids(ws, taskId, respondentId) || !text(question, 8192)) return null;
    return post(
      workPath(ws, "tasks", taskId, "questions"),
      { question, respondentId },
      c.key,
      byteLimits.work,
    );
  },
  listMyOpenQuestions: (ws: string, after: string | null) =>
    ids(ws) && cursor(after)
      ? get(
          workPath(ws, "questions") +
            query([
              ["respondent", "me"],
              ["status", "open"],
              ["limit", "50"],
              ["after", after],
            ]),
        )
      : null,
  getQuestion: (ws: string, id: string) =>
    ids(ws, id) ? get(workPath(ws, "questions", id)) : null,
  answer(ws: string, id: string, c: Command<{ text: string; expectedRevision: number }>) {
    const { text: answer, expectedRevision } = c.body;
    if (!ids(ws, id) || !text(answer, 8192) || !revision(expectedRevision)) return null;
    return post(
      workPath(ws, "questions", id, "answer"),
      { text: answer, expectedRevision },
      c.key,
      byteLimits.work,
    );
  },
  cancelQuestion(ws: string, id: string, c: Command<{ expectedRevision: number }>) {
    if (!ids(ws, id) || !revision(c.body.expectedRevision)) return null;
    return post(
      workPath(ws, "questions", id, "status"),
      { to: "cancelled", expectedRevision: c.body.expectedRevision },
      c.key,
      byteLimits.work,
    );
  },
  getAnswer: (ws: string, id: string) =>
    ids(ws, id) ? get(workPath(ws, "questions", id, "answer")) : null,
  // M2 PR-2: the connections read and the store-link routes. The body is exactly
  // {handoffToken} (the guard's closed shape); the key is the handoff's one command key.
  connections: (ws: string) => (ids(ws) ? get(`/workspace/${ws}/connections`) : null),
  // "Disconnect store": the status read and the person's kill switch, beside the
  // connections read (the work API's envelope, the connection id unencoded in the path).
  disconnectStatus: (ws: string, connectionId: string) =>
    ids(ws, connectionId) ? get(`/workspace/${ws}/connections/${connectionId}/disconnect`) : null,
  disconnect(ws: string, connectionId: string, c: Command<{ reason: string }>) {
    if (!ids(ws, connectionId) || !stopReason(c.body.reason)) return null;
    return post(
      `/workspace/${ws}/connections/${connectionId}/disconnect`,
      { control: { reason: c.body.reason, sourceProposalRef: null } },
      c.key,
      byteLimits.work,
    );
  },
  // PR 20: the shop knowledge routes (under /work; default off: uncomposed in this build).
  // Bodies are the closed shapes the server parses: typed text, and one optional note as the
  // version's only source. No tag, author, tenant or version the server assigns.
  knowledgePages: (ws: string) => (ids(ws) ? get(workPath(ws, "knowledge", "pages")) : null),
  knowledgeProposals: (ws: string) =>
    ids(ws) ? get(workPath(ws, "knowledge", "proposals")) : null,
  knowledgePage: (ws: string, pageId: string) =>
    ids(ws, pageId) ? get(workPath(ws, "knowledge", "pages", pageId)) : null,
  addKnowledge(ws: string, c: Command<KnowledgeContent & { pageKind: KnowledgePageKind }>) {
    const b = c.body;
    if (
      !ids(ws) ||
      !knowledgeContent(b) ||
      !(knowledgePageKinds as readonly string[]).includes(b.pageKind)
    )
      return null;
    return post(
      workPath(ws, "knowledge", "pages"),
      { kind: b.pageKind, title: b.title, text: b.text, sources: noteSources(b.note) },
      c.key,
      byteLimits.work,
    );
  },
  editKnowledge(
    ws: string,
    pageId: string,
    c: Command<KnowledgeContent & { expectedVersion: number }>,
  ) {
    const b = c.body;
    if (!ids(ws, pageId) || !knowledgeContent(b) || !revision(b.expectedVersion)) return null;
    return post(
      workPath(ws, "knowledge", "pages", pageId, "versions"),
      {
        expectedVersion: b.expectedVersion,
        title: b.title,
        text: b.text,
        sources: noteSources(b.note),
      },
      c.key,
      byteLimits.work,
    );
  },
  deleteKnowledge(ws: string, pageId: string, c: Command<{ expectedVersion: number }>) {
    if (!ids(ws, pageId) || !revision(c.body.expectedVersion)) return null;
    return post(
      workPath(ws, "knowledge", "pages", pageId, "delete"),
      { expectedVersion: c.body.expectedVersion },
      c.key,
      byteLimits.work,
    );
  },
  decideSuggestion(
    ws: string,
    proposalId: string,
    c: Command<{ decision: "accept" | "reject"; digest: string }>,
  ) {
    const { decision, digest } = c.body;
    if (!ids(ws, proposalId) || (decision !== "accept" && decision !== "reject") || !hex64(digest))
      return null;
    return post(
      workPath(ws, "knowledge", "proposals", proposalId, decision),
      { digest },
      c.key,
      byteLimits.work,
    );
  },
  storeLink(
    route: "preview" | "apply" | "status",
    ws: string,
    c: Command<{ handoffToken: string }>,
    csrf: string | null = null,
  ): HttpRequest | null {
    const token = c.body.handoffToken;
    if (!ids(ws) || typeof token !== "string" || !handoffTokenPattern.test(token)) return null;
    if ((route === "apply") !== (csrf !== null) || (csrf !== null && !isCsrfValue(csrf)))
      return null;
    const path =
      route === "apply" ? `/workspace/${ws}/store-links` : `/workspace/${ws}/store-links/${route}`;
    const request = post(path, { handoffToken: token }, c.key, byteLimits.link);
    if (!request || request.key === null) return null;
    return csrf !== null ? { ...request, csrf } : request;
  },
  listingsStatus: (ws: string, storeId: string) =>
    ids(ws, storeId) ? get(agentsPath(ws, storeId)) : null,
  listingsDocument: (ws: string, storeId: string, c: Command<Record<string, never>>) =>
    ids(ws, storeId) && Object.keys(c.body).length === 0
      ? post(agentsPath(ws, storeId, "document"), {}, c.key, byteLimits.work)
      : null,
  listingsEnable(
    ws: string,
    storeId: string,
    c: Command<{ documentDigest: string; nonce: string }>,
  ) {
    const { documentDigest, nonce } = c.body;
    if (!ids(ws, storeId) || !hex64(documentDigest) || !hex64(nonce)) return null;
    return post(agentsPath(ws, storeId), { documentDigest, nonce }, c.key, byteLimits.work);
  },
  listingsStop(ws: string, storeId: string, c: Command<{ reason: string }>) {
    if (!ids(ws, storeId) || !stopReason(c.body.reason)) return null;
    return post(
      agentsPath(ws, storeId, "stop"),
      { control: { reason: c.body.reason, sourceProposalRef: null } },
      c.key,
      byteLimits.work,
    );
  },
  models: (ws: string) => (ids(ws) ? get(`/workspace/${ws}/models`) : null),
  reviseModelDefault(
    ws: string,
    c: Command<{
      model: string;
      effort: string;
      maxCreditsPerProduct: number;
      expectedRevision: number | null;
    }>,
  ): HttpRequest | null {
    const { model, effort, maxCreditsPerProduct, expectedRevision } = c.body;
    if (
      !ids(ws) ||
      !isModelKey(model) ||
      !isModelKey(effort) ||
      !Number.isSafeInteger(maxCreditsPerProduct) ||
      maxCreditsPerProduct < 1 ||
      maxCreditsPerProduct > 99 ||
      !(expectedRevision === null || revision(expectedRevision)) ||
      !isCommandKey(c.key)
    )
      return null;
    const body = JSON.stringify({ model, effort, maxCreditsPerProduct, expectedRevision });
    return { method: "PUT", path: `/workspace/${ws}/settings/model-default`, body, key: c.key };
  },
  // M3 PR-2: the runs routes under /workspace/:ws/work. The admission body is exactly
  // {storeId, products, fields, selection}; selection is opaque catalogue keys or null.
  admitRun(
    ws: string,
    taskId: string,
    c: Command<{
      storeId: string;
      products: readonly string[];
      fields: readonly string[];
      selection: { readonly model: string; readonly effort: string } | null;
    }>,
  ): HttpRequest | null {
    const { storeId, products, fields, selection } = c.body;
    if (!ids(ws, taskId, storeId) || !runProducts(products) || !runFields(fields)) return null;
    if (
      selection !== null &&
      !(
        typeof selection === "object" &&
        Object.keys(selection).sort().join() === "effort,model" &&
        isModelKey(selection.model) &&
        isModelKey(selection.effort)
      )
    )
      return null;
    const request = post(
      workPath(ws, "tasks", taskId, "runs"),
      {
        storeId,
        products: [...products],
        fields: [...fields].sort(),
        selection: selection === null ? null : { model: selection.model, effort: selection.effort },
      },
      c.key,
      byteLimits.work,
    );
    return request && request.key !== null ? request : null;
  },
  runsOfTask: (ws: string, taskId: string) =>
    ids(ws, taskId) ? get(workPath(ws, "tasks", taskId, "runs")) : null,
  run: (ws: string, runId: string) =>
    ids(ws) && typeof runId === "string" && runIdPattern.test(runId)
      ? get(workPath(ws, "runs", runId))
      : null,
  reconcileRuns(ws: string, c: Command<Record<string, never>>) {
    if (!ids(ws) || Object.keys(c.body).length !== 0) return null;
    const request = post(workPath(ws, "runs-reconcile"), {}, c.key, byteLimits.work);
    return request && request.key !== null ? request : null;
  },
  // v1 PR 3: the review and apply routes under /workspace/:ws/work.
  pendingApprovals: (ws: string) =>
    ids(ws) ? get(workPath(ws, "approvals") + query([["limit", "25"]])) : null,
  review: (ws: string, proposalId: string, selected: readonly number[] | null) =>
    ids(ws, proposalId) && (selected === null || selection(selected))
      ? get(
          workPath(ws, "proposals", proposalId, "review") +
            (selected === null ? "" : "?selected=" + [...selected].sort((a, b) => a - b).join(",")),
        )
      : null,
  decide(ws: string, proposalId: string, c: Command<ReviewDecisionBody>): HttpRequest | null {
    const b = c.body;
    if (
      !ids(ws, proposalId) ||
      (b.decision !== "approve" && b.decision !== "reject") ||
      !(b.selectedTargetIndexes === null || selection(b.selectedTargetIndexes)) ||
      (b.decision === "reject" && b.selectedTargetIndexes !== null) ||
      !hex64(b.expectedDecisionDigest) ||
      !(b.soloOwnerConfirmation === null || text(b.soloOwnerConfirmation, 256)) ||
      !revision(b.expectedRevision)
    )
      return null;
    const request = post(
      workPath(ws, "proposals", proposalId, "decision"),
      {
        decision: {
          decision: b.decision,
          selectedTargetIndexes:
            b.selectedTargetIndexes === null
              ? null
              : [...b.selectedTargetIndexes].sort((x, y) => x - y),
          expectedDecisionDigest: b.expectedDecisionDigest,
          soloOwnerConfirmation: b.soloOwnerConfirmation,
          comment: null,
        },
        expectedRevision: b.expectedRevision,
      },
      c.key,
      byteLimits.work,
    );
    return request && request.key !== null ? request : null;
  },
  apply(
    ws: string,
    proposalId: string,
    c: Command<{ readonly proposalRef: RecordRefView; readonly approvalRef: RecordRefView }>,
  ): HttpRequest | null {
    const proposalRef = refOf(c.body.proposalRef, "proposal");
    const approvalRef = refOf(c.body.approvalRef, "approval");
    if (!ids(ws, proposalId) || !proposalRef || !approvalRef || proposalRef.id !== proposalId)
      return null;
    const request = post(
      workPath(ws, "proposals", proposalId, "apply"),
      { proposalRef, approvalRef },
      c.key,
      byteLimits.work,
    );
    return request && request.key !== null ? request : null;
  },
  operationsOfTask: (ws: string, taskId: string) =>
    ids(ws, taskId) ? get(workPath(ws, "tasks", taskId, "operations")) : null,
  recheck(ws: string, operationId: string, c: Command<Record<string, never>>) {
    if (!ids(ws) || !operationIdPattern.test(operationId) || Object.keys(c.body).length !== 0)
      return null;
    const request = post(
      workPath(ws, "operations", operationId, "reconcile"),
      {},
      c.key,
      byteLimits.work,
    );
    return request && request.key !== null ? request : null;
  },
  setAside(ws: string, operationId: string, c: Command<Record<string, never>>) {
    if (!ids(ws) || !operationIdPattern.test(operationId) || Object.keys(c.body).length !== 0)
      return null;
    const request = post(
      workPath(ws, "operations", operationId, "set-aside"),
      {},
      c.key,
      byteLimits.work,
    );
    return request && request.key !== null ? request : null;
  },
} as const;

export interface HttpPortOptions {
  readonly client: Client;
  readonly composed: Composed;
  readonly loginBodyVersion: 1 | 2;
  /** The current navigation's signal: reads abort when the person navigates away. */
  readonly navigationSignal: () => AbortSignal | undefined;
}

const notInBuild = { kind: "not_in_build" } as const;
const refused = { kind: "invalid", field: null } as const;
const unknownRecord = { kind: "not_found" } as const;

export function createHttpPort(options: HttpPortOptions): WorkspacePort {
  const { client, composed, loginBodyVersion, navigationSignal } = options;
  const send = (request: HttpRequest) =>
    request.method === "GET"
      ? client.get(request.path, navigationSignal())
      : request.method === "PUT"
        ? client.put(request.path, request.body, request.key)
        : client.post(
            request.path,
            request.body,
            request.key,
            request.challenge ?? null,
            request.csrf ?? null,
          );
  // people.list and session.keepAlive stay uncomposed in this build (§4.14): they
  // answer not_in_build and send nothing.
  const unbuilt = async (..._args: unknown[]) => notInBuild;
  const gated =
    <A extends unknown[], R>(method: PortMethod, run: (...args: A) => Promise<Outcome<R>>) =>
    (...args: A): Promise<Outcome<R>> =>
      composed[method] ? run(...args) : Promise.resolve(notInBuild);
  // A read whose request can't be built (an id outside the Id pattern) names a record
  // that can't exist: not_found, with nothing sent. A command that can't be built is
  // refused before sending (invalid), so it is terminal and never uncertain.
  const read = async <T>(
    request: HttpRequest | null,
    decode: (body: unknown, status: number) => T | null,
  ): Promise<Outcome<T>> =>
    request ? workOutcome(await send(request), "read", decode) : unknownRecord;
  const command = async <T>(
    request: HttpRequest | null,
    decode: (body: unknown, status: number) => T | null,
  ): Promise<Outcome<T>> =>
    request ? workOutcome(await send(request), "command", decode) : refused;
  // Run admission: a 400 refusal (the selection) keeps the server's safe message.
  const admitCommand = async <T>(
    request: HttpRequest | null,
    decode: (body: unknown, status: number) => T | null,
  ): Promise<Outcome<T>> => {
    if (!request) return refused;
    const reply = await send(request);
    const outcome = workOutcome(reply, "command", decode);
    if (outcome.kind !== "invalid" || reply.kind !== "response") return outcome;
    const envelope = decodeErrorEnvelope(reply.body);
    return envelope ? { kind: "invalid", field: null, message: envelope.safeMessage } : outcome;
  };
  // Single-record reads also check the record is the one the path names.
  const same = <T extends { readonly id: string }>(id: string, value: T | null) =>
    value !== null && value.id === id ? value : null;
  const work: WorkspacePort["work"] = {
    listGoals: gated("work.listGoals", (ws: string, after: string | null) =>
      read(requests.listGoals(ws, after), (b) => decodePage(b, (v) => decodeGoal(v, ws))),
    ),
    getGoal: gated("work.getGoal", (ws: string, id: string) =>
      read(requests.getGoal(ws, id), (b) =>
        decodeOne(b, "goal", (v) => same(id, decodeGoal(v, ws))),
      ),
    ),
    createGoal: gated(
      "work.createGoal",
      (ws: string, c: Command<{ objective: string; criteria: readonly string[] }>) =>
        command(requests.createGoal(ws, c), decodeGoalCreated),
    ),
    listTasks: gated("work.listTasks", (ws: string, goalId: string, after: string | null) =>
      read(requests.listTasks(ws, goalId, after), (b) =>
        decodePage(b, (v) => {
          const task = decodeTask(v, ws);
          return task && task.goalId === goalId ? task : null;
        }),
      ),
    ),
    getTask: gated("work.getTask", (ws: string, id: string) =>
      read(requests.getTask(ws, id), (b) =>
        decodeOne(b, "task", (v) => same(id, decodeTask(v, ws))),
      ),
    ),
    createTask: gated(
      "work.createTask",
      (ws: string, c: Command<{ goalId: string; objective: string }>) =>
        command(requests.createTask(ws, c), decodeTaskCreated),
    ),
    markReady: gated(
      "work.markReady",
      (ws: string, id: string, c: Command<{ expectedRevision: number }>) =>
        command(requests.markReady(ws, id, c), decodeRevision),
    ),
    assign: gated(
      "work.assign",
      (ws: string, id: string, c: Command<{ assigneeId: string; expectedRevision: number }>) =>
        command(requests.assign(ws, id, c), decodeRevision),
    ),
    listTaskQuestions: gated(
      "work.listTaskQuestions",
      (ws: string, taskId: string, after: string | null) =>
        read(requests.listTaskQuestions(ws, taskId, after), (b) =>
          decodePage(b, (v) => {
            const question = decodeQuestion(v, ws);
            return question && question.taskId === taskId ? question : null;
          }),
        ),
    ),
    ask: gated(
      "work.ask",
      (ws: string, taskId: string, c: Command<{ question: string; respondentId: string }>) =>
        command(requests.ask(ws, taskId, c), decodeQuestionCreated),
    ),
    listMyOpenQuestions: gated("work.listMyOpenQuestions", (ws: string, after: string | null) =>
      read(requests.listMyOpenQuestions(ws, after), (b) =>
        decodePage(b, (v) => decodeQuestion(v, ws)),
      ),
    ),
    getQuestion: gated("work.getQuestion", (ws: string, id: string) =>
      read(requests.getQuestion(ws, id), (b) =>
        decodeOne(b, "question", (v) => same(id, decodeQuestion(v, ws))),
      ),
    ),
    answer: gated(
      "work.answer",
      (ws: string, id: string, c: Command<{ text: string; expectedRevision: number }>) =>
        command(requests.answer(ws, id, c), decodeAnswered),
    ),
    cancelQuestion: gated(
      "work.cancelQuestion",
      (ws: string, id: string, c: Command<{ expectedRevision: number }>) =>
        command(requests.cancelQuestion(ws, id, c), decodeRevision),
    ),
    getAnswer: gated("work.getAnswer", (ws: string, id: string) =>
      read(requests.getAnswer(ws, id), (b) =>
        decodeOne(b, "answer", (v) => decodeAnswer(v, id, ws)),
      ),
    ),
  };
  return {
    session: {
      startSignIn: gated(
        "session.startSignIn",
        async (workspaceId: string | null, challenge: string | null = null) => {
          const request = requests.login(loginBodyVersion, workspaceId, challenge);
          return request ? decodeLoginStart(await send(request)) : refused;
        },
      ),
      signOut: gated("session.signOut", async () => decodeLogout(await send(requests.logout()))),
      keepAlive: unbuilt,
    },
    workspace: {
      bootstrap: gated("workspace.bootstrap", async (ws: string) => {
        const request = requests.bootstrap(ws);
        return request ? decodeBootstrap(await send(request), ws) : { kind: "not_found" };
      }),
    },
    account: {
      overview: gated("account.overview", async () =>
        identityOutcome(await send(requests.overview()), "read", decodeAccountOverview),
      ),
      createOrganization: gated(
        "account.createOrganization",
        async (
          c: Command<{ organizationName: string; workspaceName: string }>,
          challenge: string | null = null,
        ) => {
          const request = requests.createOrganization(c, challenge);
          return request
            ? identityOutcome(await send(request), "command", decodeOrganizationSignup)
            : refused;
        },
      ),
    },
    work,
    people: { list: unbuilt },
    // T7 PR 16: no server routes yet (T2, T4, T11, T13). Uncomposed: nothing is sent.
    team: {
      overview: unbuilt,
      agent: unbuilt,
      reviseThinking: unbuilt,
      catalogue: unbuilt,
      addDocument: unbuilt,
      addConfirm: unbuilt,
    },
    settings: {
      plan: unbuilt,
      emailAddresses: unbuilt,
      notifications: unbuilt,
      reviseNotifications: unbuilt,
      activity: unbuilt,
    },
    // PR 20: Shop knowledge over its routes; uncomposed in this build (the shop-knowledge
    // switch is committed off), so these answer not_in_build and send nothing.
    library: {
      knowledge: gated("library.knowledge", async (ws: string) => {
        const pages = await read(requests.knowledgePages(ws), decodeKnowledgePages);
        if (pages.kind !== "ok") return pages;
        const proposals = await read(requests.knowledgeProposals(ws), decodeKnowledgeProposals);
        if (proposals.kind !== "ok") return proposals;
        return {
          kind: "ok" as const,
          value: { items: [...pages.value.facts, ...proposals.value], may: pages.value.may },
          replayed: false,
        };
      }),
      knowledgePage: gated("library.knowledgePage", (ws: string, pageId: string) =>
        read(requests.knowledgePage(ws, pageId), (b) => decodeKnowledgePage(b, pageId)),
      ),
      addKnowledge: gated(
        "library.addKnowledge",
        (ws: string, c: Command<KnowledgeContent & { pageKind: KnowledgePageKind }>) =>
          command(requests.addKnowledge(ws, c), (b) => decodeKnowledgeWritten(b, null)),
      ),
      editKnowledge: gated(
        "library.editKnowledge",
        (ws: string, pageId: string, c: Command<KnowledgeContent & { expectedVersion: number }>) =>
          command(requests.editKnowledge(ws, pageId, c), (b) => {
            const written = decodeKnowledgeWritten(b, pageId);
            return written ? { version: written.version } : null;
          }),
      ),
      deleteKnowledge: gated(
        "library.deleteKnowledge",
        (ws: string, pageId: string, c: Command<{ expectedVersion: number }>) =>
          command(requests.deleteKnowledge(ws, pageId, c), (b) =>
            decodeKnowledgeDeleted(b, pageId),
          ),
      ),
      decideSuggestion: gated(
        "library.decideSuggestion",
        (
          ws: string,
          proposalId: string,
          c: Command<{ decision: "accept" | "reject"; digest: string }>,
        ) =>
          command(requests.decideSuggestion(ws, proposalId, c), (b) =>
            decodeSuggestionDecided(b, proposalId, c.body.decision),
          ),
      ),
      files: unbuilt,
    },
    // ADR-0032 Home preview: no backend, no route and no contract. Never composed over
    // HTTP, so it answers not_in_build and sends nothing.
    samples: { home: unbuilt },
    connections: {
      list: gated("connections.list", async (ws: string) => {
        const request = requests.connections(ws);
        return request ? decodeConnections(await send(request), ws) : unknownRecord;
      }),
      disconnectStatus: gated("connections.disconnectStatus", (ws: string, connectionId: string) =>
        read(requests.disconnectStatus(ws, connectionId), (b) =>
          decodeDisconnectStatus(b, connectionId),
        ),
      ),
      disconnect: gated(
        "connections.disconnect",
        (ws: string, connectionId: string, c: Command<{ reason: string }>) =>
          command(requests.disconnect(ws, connectionId, c), (b) =>
            decodeDisconnectResult(b, connectionId),
          ),
      ),
    },
    storeLinks: {
      preview: gated(
        "storeLinks.preview",
        async (ws: string, c: Command<{ handoffToken: string }>) => {
          const request = requests.storeLink("preview", ws, c);
          return request ? decodeStoreLinkPreview(await send(request)) : refused;
        },
      ),
      apply: gated(
        "storeLinks.apply",
        async (ws: string, c: Command<{ handoffToken: string }>, csrf: string) => {
          const request = requests.storeLink("apply", ws, c, csrf);
          return request ? decodeStoreLinkResult(await send(request)) : refused;
        },
      ),
      status: gated(
        "storeLinks.status",
        async (ws: string, c: Command<{ handoffToken: string }>) => {
          const request = requests.storeLink("status", ws, c);
          return request ? decodeStoreLinkResult(await send(request)) : refused;
        },
      ),
    },
    agents: {
      listingsStatus: gated("agents.listingsStatus", (ws: string, storeId: string) =>
        read(requests.listingsStatus(ws, storeId), (b) => decodeListingsStatus(b, storeId)),
      ),
      listingsDocument: gated(
        "agents.listingsDocument",
        async (ws: string, storeId: string, c: Command<Record<string, never>>) => {
          const request = requests.listingsDocument(ws, storeId, c);
          if (!request) return refused;
          const reply = await send(request);
          // A replayed document never carries its nonce again (it is returned once), so
          // it cannot be confirmed: a terminal conflict, and the person starts again.
          if (
            reply.kind === "response" &&
            reply.status === 200 &&
            reply.body !== null &&
            typeof reply.body === "object" &&
            (reply.body as Record<string, unknown>).replayed === true &&
            (reply.body as Record<string, unknown>).nonce === null
          )
            return { kind: "conflict", recheck: true, message: "" } as const;
          return workOutcome(reply, "command", (b) => decodeListingsDocument(b, storeId));
        },
      ),
      listingsEnable: gated(
        "agents.listingsEnable",
        (ws: string, storeId: string, c: Command<{ documentDigest: string; nonce: string }>) =>
          command(requests.listingsEnable(ws, storeId, c), decodeListingsChange),
      ),
      listingsStop: gated(
        "agents.listingsStop",
        (ws: string, storeId: string, c: Command<{ reason: string }>) =>
          command(requests.listingsStop(ws, storeId, c), decodeListingsChange),
      ),
    },
    runs: {
      admit: gated(
        "runs.admit",
        (
          ws: string,
          taskId: string,
          c: Command<{
            storeId: string;
            products: readonly string[];
            fields: readonly string[];
            selection: { readonly model: string; readonly effort: string } | null;
          }>,
        ) => admitCommand(requests.admitRun(ws, taskId, c), decodeRunAdmitted),
      ),
      listOfTask: gated("runs.listOfTask", (ws: string, taskId: string) =>
        read(requests.runsOfTask(ws, taskId), (b) => decodeRunsOfTask(b, taskId)),
      ),
      get: gated("runs.get", (ws: string, runId: string) =>
        read(requests.run(ws, runId), (b) => decodeRunDetail(b, runId)),
      ),
      reconcile: gated("runs.reconcile", (ws: string, c: Command<Record<string, never>>) =>
        command(requests.reconcileRuns(ws, c), decodeReconciled),
      ),
    },
    review: {
      listPending: gated("review.listPending", (ws: string) =>
        read(requests.pendingApprovals(ws), decodePendingApprovals),
      ),
      get: gated(
        "review.get",
        (ws: string, proposalId: string, selected: readonly number[] | null) =>
          read(requests.review(ws, proposalId, selected), (b) => decodeReview(b, proposalId)),
      ),
      decide: gated(
        "review.decide",
        (ws: string, proposalId: string, c: Command<ReviewDecisionBody>) =>
          command(requests.decide(ws, proposalId, c), decodeDecided),
      ),
      apply: gated(
        "review.apply",
        (
          ws: string,
          proposalId: string,
          c: Command<{ readonly proposalRef: RecordRefView; readonly approvalRef: RecordRefView }>,
        ) => command(requests.apply(ws, proposalId, c), decodeApplied),
      ),
      operationsOfTask: gated("review.operationsOfTask", (ws: string, taskId: string) =>
        read(requests.operationsOfTask(ws, taskId), (b) => decodeOperationsOfTask(b, taskId)),
      ),
      recheck: gated(
        "review.recheck",
        (ws: string, operationId: string, c: Command<Record<string, never>>) =>
          command(requests.recheck(ws, operationId, c), (b) => decodeRechecked(b, operationId)),
      ),
      setAside: gated(
        "review.setAside",
        (ws: string, operationId: string, c: Command<Record<string, never>>) =>
          command(requests.setAside(ws, operationId, c), (b) => decodeSetAside(b, operationId)),
      ),
    },
    models: {
      list: gated("models.list", (ws: string) => read(requests.models(ws), decodeModels)),
      reviseDefault: gated(
        "models.reviseDefault",
        (
          ws: string,
          c: Command<{
            model: string;
            effort: string;
            maxCreditsPerProduct: number;
            expectedRevision: number | null;
          }>,
        ) => command(requests.reviseModelDefault(ws, c), decodeModelDefaultRevised),
      ),
    },
    // T7 PR 19 (ADR-0033, ADR-0034): the project screens. No route or decoder exists yet
    // (T2 and T6 build them), so this build never composes these: each answers
    // not_in_build and sends nothing. Each is wired here, with its decoder and tests, in
    // the PR that lands its route, and composed in `composed.ts` then.
    projects: {
      overview: unbuilt,
      tasks: unbuilt,
      repeating: unbuilt,
      get: unbuilt,
      messages: unbuilt,
      post: unbuilt,
      planNextSteps: unbuilt,
      stopSteps: unbuilt,
      extend: unbuilt,
      finishDocument: unbuilt,
      create: unbuilt,
    },
    plans: {
      ask: unbuilt,
      conversation: unbuilt,
      answer: unbuilt,
      revise: unbuilt,
      startDocument: unbuilt,
      start: unbuilt,
    },
  };
}
