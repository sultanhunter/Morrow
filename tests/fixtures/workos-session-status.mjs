// Synthetic provider records only. No account, credential or provider request.
export const workosSessionStatusId = (prefix, number) =>
  prefix + "_" + number.toString(32).toUpperCase().padStart(26, "0");

export function buildWorkosSessionStatusFixture() {
  const at = 1800000000000;
  const profile = {
    schemaVersion: 1,
    providerId: "workos",
    environmentId: workosSessionStatusId("environment", 1),
    applicationId: workosSessionStatusId("app", 2),
    clientId: workosSessionStatusId("client", 3),
    revision: 1,
  };
  const query = {
    schemaVersion: 1,
    subjectId: workosSessionStatusId("user", 4),
    providerSessionId: workosSessionStatusId("session", 5),
  };
  const session = (changes = {}) => ({
    object: "session",
    id: query.providerSessionId,
    user_id: query.subjectId,
    status: "active",
    ended_at: null,
    created_at: new Date(at - 60000).toISOString(),
    updated_at: new Date(at - 1000).toISOString(),
    expires_at: new Date(at + 60000).toISOString(),
    ...changes,
  });
  const page = (data = [], after = null, before = null) =>
    JSON.stringify({ object: "list", data, list_metadata: { before, after } });
  return {
    at,
    profile,
    profileJson: JSON.stringify(profile),
    query,
    queryJson: JSON.stringify(query),
    session,
    page,
  };
}
