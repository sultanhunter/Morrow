// Pure lexical checks on a migration's SQL text (ADR-0020 item 5, P04.T01j D4). The
// runner sends each manifest entry as one transaction under SET LOCAL ROLE <executeAs>,
// with its own grant and revoke of the SET row around the file. That holds only if the
// file is one transaction that never ends, restarts or leaves the executeAs role early:
// an inner COMMIT would commit the SET row, and a RESET ROLE would run the rest of the
// file as the administrator. The scanner follows the PostgreSQL and psql lexical rules
// these files use: -- and nested /* */ comments, '' and E'' strings, "" identifiers,
// $tag$ bodies, and psql's rule that a semicolon inside parentheses or inside the
// BEGIN ... END of a CREATE [OR REPLACE] FUNCTION|PROCEDURE (BEGIN ATOMIC) does not end
// the statement. It never executes or rewrites SQL.

const dollarTag = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const word = /[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y;

// One pass over `text`. Returns the top-level statements (comments removed, quoted text
// kept, trimmed, split where psql splits them), the comment-free code of the whole text
// including every dollar-quoted body with its own comments removed, and whether a psql
// meta-command (a backslash outside any quote or comment) appears. Throws
// SQL_SCRIPT_UNTERMINATED on an unterminated comment, quote or body.
export function scanSqlScript(text) {
  if (typeof text !== "string") throw Error("SQL_SCRIPT_UNTERMINATED");
  const statements = [];
  let statement = "";
  let code = "";
  let metaCommand = false;
  // psql's heuristic (psqlscan.l): the first four words of the statement, the
  // parenthesis depth and the BEGIN ... END depth of a routine body.
  let words = [];
  let parens = 0;
  let blocks = 0;
  const emit = (piece) => {
    statement += piece;
    code += piece;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= text.length) throw Error("SQL_SCRIPT_UNTERMINATED");
        if (text[i] === "/" && text[i + 1] === "*") ((depth += 1), (i += 2));
        else if (text[i] === "*" && text[i + 1] === "/") ((depth -= 1), (i += 2));
        else i += 1;
      }
      emit(" ");
      continue;
    }
    if (c === "'" || c === '"') {
      const escapes = c === "'" && /(^|[^A-Za-z0-9_$])[eE]$/.test(statement);
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw Error("SQL_SCRIPT_UNTERMINATED");
        if (escapes && text[j] === "\\") j += 2;
        else if (text[j] === c && text[j + 1] === c) j += 2;
        else if (text[j] === c) break;
        else j += 1;
      }
      emit(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "$") {
      dollarTag.lastIndex = i;
      const tag = dollarTag.exec(text)?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) throw Error("SQL_SCRIPT_UNTERMINATED");
        const body = text.slice(i + tag.length, end);
        statement += tag + body + tag;
        code += tag + scanSqlScript(body).code + tag;
        i = end + tag.length;
        continue;
      }
    }
    word.lastIndex = i;
    const token = word.exec(text)?.[0];
    if (token) {
      const lower = token.toLowerCase();
      if (words.length < 4) words.push(lower);
      const routine =
        words[0] === "create" &&
        (["function", "procedure"].includes(words[1]) ||
          (words[1] === "or" &&
            words[2] === "replace" &&
            ["function", "procedure"].includes(words[3])));
      if (routine && parens === 0) {
        if (lower === "begin") blocks += 1;
        else if (lower === "case" && blocks > 0) blocks += 1;
        else if (lower === "end" && blocks > 0) blocks -= 1;
      }
      emit(token);
      i += token.length;
      continue;
    }
    if (c === "\\") metaCommand = true;
    if (c === "(") parens += 1;
    if (c === ")" && parens > 0) parens -= 1;
    if (c === ";" && parens === 0 && blocks === 0) {
      statements.push(statement.trim());
      statement = "";
      words = [];
      code += ";";
      i += 1;
      continue;
    }
    emit(c);
    i += 1;
  }
  if (statement.trim()) statements.push(statement.trim());
  return { statements, code, metaCommand };
}

const transactionControl =
  /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
// A role or session switch anywhere in the code, including routine and DO bodies and
// strings that EXECUTE could run: SET/RESET [SESSION|LOCAL] ROLE, SESSION AUTHORIZATION,
// the session_authorization parameter, or set_config('role'|'session_authorization', ...).
const roleSwitch =
  /\b(SET|RESET)\s+((SESSION|LOCAL)\s+)?(ROLE|SESSION\s+AUTHORIZATION|SESSION_AUTHORIZATION)\b|\bset_config\s*\(\s*'(role|session_authorization)'/i;

// The violations of the runner contract in one migration file, as a sorted list of fixed
// codes (empty when the file qualifies): exactly one transaction, "BEGIN;" first and
// "COMMIT;" last, with no other transaction control, no role or session switch and no
// psql meta-command anywhere.
export function migrationSqlViolations(text) {
  let scan;
  try {
    scan = scanSqlScript(text);
  } catch {
    return ["MIGRATION_SQL_UNTERMINATED"];
  }
  const violations = new Set();
  const { statements } = scan;
  if (
    statements.length < 2 ||
    !/^BEGIN$/i.test(statements[0]) ||
    !/^COMMIT$/i.test(statements.at(-1)) ||
    !/;\s*$/.test(scan.code)
  )
    violations.add("MIGRATION_TRANSACTION_ENVELOPE");
  if (statements.slice(1, -1).some((s) => transactionControl.test(s)))
    violations.add("MIGRATION_TRANSACTION_CONTROL");
  if (roleSwitch.test(scan.code)) violations.add("MIGRATION_ROLE_SWITCH");
  if (scan.metaCommand) violations.add("MIGRATION_PSQL_META_COMMAND");
  return [...violations].sort();
}
