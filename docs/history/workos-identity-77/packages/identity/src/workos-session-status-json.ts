const encoder = new TextEncoder();
const invalid = () => Error("WORKOS_SESSION_STATUS_JSON_INVALID");

function paired(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid();
    } else if (code >= 0xdc00 && code <= 0xdfff) throw invalid();
  }
}

// Data boundaries accept primitive text only. Decoding bytes belongs to the
// transport; this parser also rejects escaped malformed UTF16 and duplicate
// decoded member names before JSON.parse can discard their ambiguity.
export function parseWorkosSessionStatusJson(value: unknown, maxBytes: number): unknown {
  try {
    if (
      typeof value !== "string" ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 524288 ||
      value.length > maxBytes
    )
      throw invalid();
    paired(value);
    if (encoder.encode(value).byteLength > maxBytes) throw invalid();
    let at = 0;
    let nodes = 0;
    const whitespace = () => {
      while (/[\x20\t\r\n]/.test(value[at] ?? "!")) at++;
    };
    const string = (): string => {
      const start = at++;
      while (at < value.length) {
        const character = value[at++];
        if (character === '"') {
          const decoded: unknown = JSON.parse(value.slice(start, at));
          if (typeof decoded !== "string") throw invalid();
          paired(decoded);
          return decoded;
        }
        if (character === "\\") at++;
      }
      throw invalid();
    };
    const item = (depth: number): void => {
      if (++nodes > 16384 || depth > 32) throw invalid();
      whitespace();
      const character = value[at];
      if (character === '"') {
        string();
        return;
      }
      if (character === "{" || character === "[") {
        const object = character === "{";
        const close = object ? "}" : "]";
        const names = new Set<string>();
        at++;
        whitespace();
        if (value[at] === close) {
          at++;
          return;
        }
        while (true) {
          if (object) {
            whitespace();
            if (value[at] !== '"') throw invalid();
            const name = string();
            if (names.has(name)) throw invalid();
            names.add(name);
            whitespace();
            if (value[at++] !== ":") throw invalid();
          }
          item(depth + 1);
          whitespace();
          if (value[at] === close) {
            at++;
            return;
          }
          if (value[at++] !== ",") throw invalid();
        }
      }
      const primitive =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          value.slice(at),
        );
      if (!primitive) throw invalid();
      at += primitive[0].length;
    };
    item(0);
    whitespace();
    if (at !== value.length) throw invalid();
    return JSON.parse(value);
  } catch {
    throw invalid();
  }
}
