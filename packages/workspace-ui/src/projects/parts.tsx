// Small parts the project screens share: the word badge (a glyph and a word, never colour
// alone), health and status words, and a member's name with its Agent or Specialist pill.
// When the Sunrise shell (T7 PR 14) lands, the badge and pill move onto its `Tag` and
// `AgentName`; the class names here are this folder's own (`pj-`).
import type { ReactNode } from "react";
import { projectsCopy } from "./copy";
import { healthStyle, statusStyle, type WordGlyph, type WordStyle } from "./format";
import type { HealthView, MemberView } from "./model";

function glyphShape(glyph: WordGlyph): ReactNode {
  const ring = <circle cx="7" cy="7" r="5.2" stroke="currentColor" strokeWidth="1.6" />;
  switch (glyph) {
    case "ring":
      return (
        <circle
          cx="7"
          cy="7"
          r="5.2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray="2.4 1.68"
        />
      );
    case "half":
      return (
        <>
          {ring}
          <path d="M7 3.6 A3.4 3.4 0 0 1 7 10.4 Z" fill="currentColor" />
        </>
      );
    case "check":
      return (
        <>
          {ring}
          <path
            d="M4.7 7.2 L6.3 8.8 L9.4 5.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "alert":
      return (
        <>
          {ring}
          <path d="M7 4.3 V7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="7" cy="9.8" r="0.95" fill="currentColor" />
        </>
      );
    case "pause":
      return (
        <>
          {ring}
          <path d="M5.8 5 V9 M8.2 5 V9" stroke="currentColor" strokeWidth="1.6" />
        </>
      );
    case "minus":
      return (
        <>
          {ring}
          <path d="M4.6 7 H9.4" stroke="currentColor" strokeWidth="1.6" />
        </>
      );
    default:
      return ring;
  }
}

/** A 14 px glyph and one word in a tone; plain text when the style has no tone. */
export function WordBadge({ style }: { readonly style: WordStyle }) {
  if (style.tone === null) return <span className="pj-plain-word">{style.label}</span>;
  return (
    <span className={`pj-badge pj-badge-${style.tone}`}>
      <svg
        className="pj-badge-glyph"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        {glyphShape(style.glyph)}
      </svg>
      <span dir="auto">{style.label}</span>
    </span>
  );
}
export function HealthWord({ health }: { readonly health: HealthView }) {
  return <WordBadge style={healthStyle(health)} />;
}
export function StatusWord({ status }: { readonly status: string }) {
  return <WordBadge style={statusStyle(status)} />;
}

/** A member's name, followed by the Agent or Specialist pill where it applies. */
export function MemberName({ member }: { readonly member: MemberView }) {
  const pill =
    member.kind === "agent" || member.kind === "morrow"
      ? projectsCopy.member.agent
      : member.kind === "specialist"
        ? projectsCopy.member.specialist
        : null;
  return (
    <span className="pj-member">
      <span className={`pj-avatar pj-avatar-${member.kind}`} aria-hidden="true">
        {member.name.trim().slice(0, 1).toUpperCase()}
      </span>
      <span dir="auto" className="pj-member-name">
        {member.name}
      </span>
      {pill ? <span className="pj-pill">{pill}</span> : null}
    </span>
  );
}
/** Names joined for a row ("Morrow, Maya Chen and Listings"). */
export function memberList(members: readonly MemberView[]): string {
  const names = members.map((m) => m.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A section card with an h2 and an optional action beside it. */
export function Section({
  id,
  title,
  action,
  children,
  className,
}: {
  readonly id: string;
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={`pj-card${className ? " " + className : ""}`} aria-labelledby={id}>
      <div className="pj-card-head">
        <h2 id={id}>{title}</h2>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

/** A cell label: always read by screen readers, shown only where rows stack. */
export function CellLabel({ children }: { readonly children: string }) {
  return <span className="pj-cell-label">{children}</span>;
}
