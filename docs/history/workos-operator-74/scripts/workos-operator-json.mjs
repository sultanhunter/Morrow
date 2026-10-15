// Bounded provider/private JSON parsing only. Never inspect a caller object.
const encoder = new TextEncoder();
const invalid = () => Error("WORKOS_OPERATOR_JSON_INVALID");
function paired(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw invalid();
  }
}
export function parseWorkosOperatorJson(text, maximumBytes) {
  if (
    typeof text !== "string" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 131072 ||
    text.length > maximumBytes
  )
    throw invalid();
  try {
    paired(text);
    if (encoder.encode(text).length > maximumBytes) throw invalid();
    let at = 0,
      nodes = 0;
    const whitespace = () => {
      while (/[\x20\t\r\n]/.test(text[at] ?? "!")) at++;
    };
    const string = () => {
      const start = at++;
      while (at < text.length) {
        const character = text[at++];
        if (character === '"') {
          const value = JSON.parse(text.slice(start, at));
          if (typeof value !== "string") throw invalid();
          paired(value);
          return value;
        }
        if (character === "\\") at++;
      }
      throw invalid();
    };
    const value = (depth) => {
      if (++nodes > 16384 || depth > 32) throw invalid();
      whitespace();
      const character = text[at];
      if (character === '"') {
        string();
        return;
      }
      if (character === "{" || character === "[") {
        const object = character === "{",
          close = object ? "}" : "]",
          names = new Set();
        at++;
        whitespace();
        if (text[at] === close) {
          at++;
          return;
        }
        while (true) {
          if (object) {
            whitespace();
            if (text[at] !== '"') throw invalid();
            const name = string();
            if (names.has(name)) throw invalid();
            names.add(name);
            whitespace();
            if (text[at++] !== ":") throw invalid();
          }
          value(depth + 1);
          whitespace();
          if (text[at] === close) {
            at++;
            return;
          }
          if (text[at++] !== ",") throw invalid();
        }
      }
      const primitive =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          text.slice(at),
        );
      if (!primitive) throw invalid();
      at += primitive[0].length;
    };
    value(0);
    whitespace();
    if (at !== text.length) throw invalid();
    return JSON.parse(text);
  } catch {
    throw invalid();
  }
}
