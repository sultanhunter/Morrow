// A synthetic SQL pool for the self-rotation control and dispatcher tests (P05.T01y).
// It answers the fixed statements of selfRotationSql only; it proves no SQL behaviour
// (lab:session-lifecycle-sql and lab:standalone-rotate-https do).
import { selfRotationSql } from "../../packages/identity/src/self-session-rotation-control.ts";

export const rotationRole = (changes = {}) => ({
  role: "morrow_identity_logout",
  login: "morrow_identity_logout",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
  ...changes,
});
const stageOf = (text) => Object.entries(selfRotationSql).find(([, v]) => v === text)?.[0];

// options.row(state) → the rotate row; options.stage(name, state) may throw or await.
export function createRotationPool(options = {}) {
  let at = options.at ?? 1800000000000;
  const state = {
    calls: [],
    releases: [],
    connections: 0,
    now: () => at,
    setTime: (value) => {
      at = value;
    },
  };
  const rotated = () => ({
    outcome: "rotated",
    idle_expires_at_ms: String(at + 1800000),
    absolute_expires_at_ms: String(at + 40000000),
  });
  state.pool = {
    async connect(control) {
      state.connections++;
      state.calls.push({ stage: "connect", control });
      await options.stage?.("connect", state);
      return {
        async query(text, values, queryControl) {
          const stage = stageOf(text);
          state.calls.push({ stage, values: [...values], control: queryControl });
          await options.stage?.(stage, state);
          if (stage === "role") return { rows: [options.role ?? rotationRole()] };
          if (stage === "rotate") return { rows: [options.row ? options.row(state) : rotated()] };
          return { rows: [] };
        },
        async release(discard) {
          state.releases.push(discard);
          await options.stage?.("release", state);
        },
      };
    },
  };
  return state;
}
