import type { CapabilityInput, CapabilityOutput } from "./generated/domain";
const goodInput: CapabilityInput<"workspace.goal.create"> = {
  objective: "Investigate",
  storeIds: ["demo"],
  successCriteria: [
    { description: "Evidence", verificationCapabilityId: null, evidenceRequired: true },
  ],
};
const badInput: CapabilityInput<"workspace.goal.create"> = {
  // @ts-expect-error objective has a static string type
  objective: 12,
  storeIds: [],
  successCriteria: [],
};
// @ts-expect-error required revision cannot disappear
const badOutput: CapabilityOutput<"workspace.goal.create"> = { goalId: "goal" };
// @ts-expect-error unknown capability is not callable
export type BadCapability = CapabilityInput<"invented.capability">;
void goodInput;
void badInput;
void badOutput;
