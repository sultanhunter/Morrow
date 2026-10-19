// Shared closed-output rules for the staging tools (P04.T01i D2 "Errors" and "Output").
// Every failure is a StagingError: a fixed code plus closed primitive details (integers,
// booleans, short identifier-shaped strings). It carries no message text from a child
// process, a parser, a driver or the database, and no `cause`.
export const stagingCode = /^(STAGING|MIGRATION|PREREQUISITE)_[A-Z0-9_]{2,80}$/;
const detailString = /^[A-Za-z0-9_.:/@+-]{0,96}$/;

export function closedValue(value) {
  if (typeof value === "boolean" || value === null) return value;
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && detailString.test(value)) return value;
  if (Array.isArray(value) && value.length <= 64) {
    const items = value.map(closedValue);
    return items.every((item) => item !== undefined) ? items : undefined;
  }
  return undefined;
}

export class StagingError extends Error {
  constructor(code, details = {}) {
    const fixed = stagingCode.test(code) ? code : "STAGING_INTERNAL_ERROR";
    super(fixed);
    this.name = "StagingError";
    this.code = fixed;
    const closed = {};
    for (const [key, value] of Object.entries(details ?? {})) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(key)) continue;
      const v = closedValue(value);
      if (v !== undefined) closed[key] = v;
    }
    this.details = Object.freeze(closed);
  }
}

// The one projection of an unknown failure: its fixed code if it is ours, else a generic
// code. Never the message of a foreign error (Node's JSON.parse quotes its input and
// ERR_INVALID_URL carries `input`).
export function failureRecord(error) {
  if (error instanceof StagingError) return { code: error.code, ...error.details };
  if (error && typeof error.code === "string" && stagingCode.test(error.code))
    return {
      code: error.code,
      ...(Array.isArray(error.codes) ? { codes: closedValue(error.codes) ?? [] } : {}),
    };
  return { code: "STAGING_INTERNAL_ERROR" };
}

// Any code a migration or definer raises is a fixed upper-case identifier; anything
// else from the server is reduced to its SQLSTATE.
export const fixedServerMessage = (message) =>
  typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : null;
export const sqlState = (value) =>
  typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) ? value : null;
