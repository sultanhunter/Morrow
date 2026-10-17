import {
  createWorkersManagedWorkspaceApi,
  type ManagedWorkspaceApiDependencies,
} from "../../../packages/identity/src/managed-workspace-api.js";

// The configured local fixture imports this exact entry constructor. The
// ordinary artifact intentionally has no account/secret/environment binding.
export function createWorkspaceApiWorker(dependencies?: ManagedWorkspaceApiDependencies) {
  return createWorkersManagedWorkspaceApi(dependencies);
}

export default createWorkspaceApiWorker();
