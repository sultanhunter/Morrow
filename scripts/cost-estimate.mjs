import { estimateStackComponents } from "./stack-cost.mjs";
import { read } from "./foundation.mjs";
if (process.argv[1]?.endsWith("/cost-estimate.mjs")) {
  const model = read("docs/decisions/cost-model.json");
  console.log(JSON.stringify(estimateStackComponents(model, model.example_usage), null, 2));
}
