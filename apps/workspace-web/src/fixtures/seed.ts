// The Linen & Form sample (P14.T01a §4.11): synthetic data only (invariant 16).
// One workspace, three goals, six tasks and four questions. Creates append here, in
// memory, for the life of the page.
import type { GoalView, PersonRef, QuestionView, TaskView } from "@morrow/workspace-ui";

export const fixtureWorkspace = { id: "ws-linen", displayName: "Linen & Form", policyRevision: 7 };
const person = (principalId: string): PersonRef => ({
  principalId,
  kind: "human",
  label: null,
  isSelf: null,
});
export const people = {
  owner: person("prn-sample-7f3a"),
  editor: person("prn-sample-2c91"),
  reviewer: person("prn-sample-b04e"),
};
const at = (day: number, hour: number) =>
  `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

export interface FixtureSeed {
  goals: GoalView[];
  tasks: TaskView[];
  questions: QuestionView[];
  answers: Record<string, { text: string; by: PersonRef; at: string }>;
}
export function createSeed(): FixtureSeed {
  return {
    goals: [
      {
        id: "goal-autumn",
        objective: "Launch the autumn linen collection with accurate product details",
        status: "active",
        criteria: ["Every product page names its linen source", "Images reviewed by the owner"],
        owner: people.owner,
        revision: 3,
        updatedAt: at(12, 9),
      },
      {
        id: "goal-care",
        objective: "Publish clear care instructions for every linen item",
        status: "draft",
        criteria: ["Care guide covers washing and drying"],
        owner: people.editor,
        revision: 1,
        updatedAt: at(13, 14),
      },
      {
        id: "goal-returns",
        objective: "Shorten the returns policy page",
        status: "paused",
        criteria: ["Policy fits on one screen"],
        owner: people.owner,
        revision: 2,
        updatedAt: at(10, 11),
      },
    ],
    tasks: [
      {
        id: "task-titles",
        goalId: "goal-autumn",
        objective: "Draft product titles for the autumn range",
        status: "draft",
        owner: people.editor,
        revision: 2,
        updatedAt: at(14, 10),
      },
      {
        id: "task-source",
        goalId: "goal-autumn",
        objective: "Confirm the linen source with the supplier",
        status: "waiting_input",
        owner: people.owner,
        revision: 4,
        updatedAt: at(14, 16),
      },
      {
        id: "task-images",
        goalId: "goal-autumn",
        objective: "Choose the lead image for each product",
        status: "ready",
        owner: people.reviewer,
        revision: 1,
        updatedAt: at(15, 9),
      },
      {
        id: "task-care-copy",
        goalId: "goal-care",
        objective: "Write the washing guide",
        status: "draft",
        owner: people.editor,
        revision: 1,
        updatedAt: at(13, 15),
      },
      {
        id: "task-care-icons",
        goalId: "goal-care",
        objective: "Pick care symbols for the labels",
        status: "archived_by_future_version",
        owner: people.editor,
        revision: 1,
        updatedAt: at(13, 16),
      },
      {
        id: "task-returns",
        goalId: "goal-returns",
        objective: "Trim the returns page to one screen",
        status: "paused",
        owner: people.owner,
        revision: 3,
        updatedAt: at(10, 12),
      },
    ],
    questions: [
      {
        id: "q-source",
        taskId: "task-source",
        prompt: "Which supplier certificate should product pages cite?",
        status: "open",
        respondent: people.owner,
        revision: 1,
        updatedAt: at(14, 16),
        expiresAt: null,
      },
      {
        id: "q-images",
        taskId: "task-images",
        prompt: "Should the lead image show the garment folded or worn?",
        status: "open",
        respondent: people.owner,
        revision: 1,
        updatedAt: at(15, 9),
        expiresAt: null,
      },
      {
        id: "q-titles",
        taskId: "task-titles",
        prompt: "May titles include the colour name?",
        status: "answered",
        respondent: people.owner,
        revision: 2,
        updatedAt: at(14, 11),
        expiresAt: null,
      },
      {
        id: "q-returns",
        taskId: "task-returns",
        prompt: "Keep the 30-day window?",
        status: "cancelled",
        respondent: people.reviewer,
        revision: 2,
        updatedAt: at(10, 13),
        expiresAt: null,
      },
    ],
    answers: {
      "q-titles": {
        text: "Yes, after the product type: Linen Shirt, Off White.",
        by: people.owner,
        at: at(14, 11),
      },
    },
  };
}
