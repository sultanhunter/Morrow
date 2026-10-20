// The agents routes' operation names, with no imports: the api Worker's type graph (its
// edge typecheck runs against the workerd runtime types, without Node's) reaches these
// through http.ts and never the policy kernels behind commands.ts.
export type AgentCommandType =
  | "installation.document"
  | "installation.enable"
  | "installation.stop"
  | "model_default.revise";
export type AgentRead = "listings.status" | "models.list";
