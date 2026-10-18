// Compile-time checks for the review facts; typechecked only, never imported.
import type { Current_HumanActorRef } from "@morrow/contracts";
import type { ProposalTaskFacts } from "./review-facts";

declare const leo: Current_HumanActorRef;
// ADR-0018: a task and its requester exist together, so producers cannot pair them wrongly.
const tasked: ProposalTaskFacts = { taskId: "task_a", requestedBy: leo };
const taskless: ProposalTaskFacts = { taskId: null, requestedBy: null };
// @ts-expect-error a task always has a requester
const noRequester: ProposalTaskFacts = { taskId: "task_a", requestedBy: null };
// @ts-expect-error no task has no requester
const strayRequester: ProposalTaskFacts = { taskId: null, requestedBy: leo };

void tasked;
void taskless;
void noRequester;
void strayRequester;
