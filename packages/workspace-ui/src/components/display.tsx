// Display primitives (ADR-0032 Sunrise): icons (aria-hidden inline SVG), badges with a
// glyph and a word, opaque person labels and times. Record text always renders as React
// text with dir="auto". Colours come only from tokens.css, through classes.
import type { ReactNode } from "react";
import { statusLabel } from "../copy";
import { personLabel, type PersonRef } from "../model";

// 24 px outline icons, drawn at 20 with a 1.75 stroke (the boards' sidebar set).
const paths = {
  home: ["M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"],
  inbox: [
    "M4 13.5 6.4 6a1.5 1.5 0 0 1 1.4-1h8.4a1.5 1.5 0 0 1 1.4 1L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z",
    "M4 13.5h4.5l1 2.5h5l1-2.5H20",
  ],
  work: [
    "M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z",
  ],
  agents: [
    "M5.75 8.5a3.25 3.25 0 1 0 6.5 0 3.25 3.25 0 1 0-6.5 0",
    "M3.5 19.5c.5-3.4 2.7-5.2 5.5-5.2s5 1.8 5.5 5.2",
    "M14.15 9.5a2.6 2.6 0 1 0 5.2 0 2.6 2.6 0 1 0-5.2 0",
    "M15.6 14.4c2.6-.3 4.5 1.4 4.9 4.6",
  ],
  knowledge: ["M4.5 5.5a2 2 0 0 1 2-2h13v14h-13a2 2 0 0 0-2 2z", "M4.5 19.5a2 2 0 0 0 2 2h13v-4"],
  assets: [
    "M7 3.5h6.8l4.7 4.7v11.3a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z",
    "M13.5 3.75V8.5h4.75",
    "M9 12.5h6M9 16h6",
  ],
  settings: [
    "M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z",
  ],
  store: [
    "M4.5 9.5 6 4.5h12l1.5 5",
    "M4.5 9.5a1.875 1.875 0 0 0 3.75 0 1.875 1.875 0 0 0 3.75 0 1.875 1.875 0 0 0 3.75 0 1.875 1.875 0 0 0 3.75 0",
    "M5.5 11.8v7.7h13v-7.7",
    "M10 19.5V15h4v4.5",
  ],
  credits: [
    "M5.5 7a6.5 2.5 0 1 0 13 0 6.5 2.5 0 1 0-13 0",
    "M5.5 7v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V7",
    "M5.5 12v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5",
  ],
  search: ["M4.5 11a6.5 6.5 0 1 0 13 0 6.5 6.5 0 1 0-13 0", "m16 16 4 4"],
  question: [
    "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z",
    "M9.8 8.9a2.3 2.3 0 0 1 4.4.9c0 1.5-2.2 1.9-2.2 3.1",
    "M12 15.3h.01",
  ],
  clock: ["M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0", "M12 7.5V12l3 2"],
  menu: ["M4 7h16 M4 12h16 M4 17h16"],
  close: ["m6 6 12 12 M6 18 18 6"],
  check: ["m5 12 4 4L19 6"],
  chevron: ["m6 9 6 6 6-6"],
  forward: ["M9 6 L15 12 L9 18"],
  back: ["M15 6 L9 12 L15 18"],
  plus: ["M12 5v14 M5 12h14"],
  external: [
    "M14 4h6v6",
    "M20 4 11 13",
    "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  ],
  document: ["M5 2h9l5 5v15H5z", "M14 2v6h5"],
  // The Settings sub-navigation (the ConnectStore and SettingsActivity boards).
  bell: ["M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0"],
  mail: ["M3 5h18v14H3z", "M3 6l9 7 9-7"],
  stop: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M9 9h6v6H9z"],
  sliders: ["M4 7h9", "M17 7h3", "M15 5v4", "M4 17h3", "M11 17h9", "M9 15v4"],
  activity: [
    "M4 6h10M4 11h7M4 16h5",
    "M12.5 15.5a4 4 0 1 0 8 0 4 4 0 1 0-8 0",
    "M16.5 13.6v2l1.3 1",
  ],
} as const;
export type IconName = keyof typeof paths;
/** Icons whose shape is filled in ink when their navigation row is the current page. */
const fillable: ReadonlySet<IconName> = new Set(["home", "work", "knowledge", "assets"]);

export function Icon({ name, size = 20 }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg
      className={fillable.has(name) ? "icon icon-fillable" : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Morrow's small mark: the marigold half-sun on a horizon, without a face (ADR-0032). */
export function MorrowMark({ size = 20 }: { readonly size?: number }) {
  return (
    <svg
      className="morrow-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="morrow-mark-sun"
        d="M6.5 16 A5.5 5.5 0 0 1 17.5 16 Z"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <g className="morrow-mark-line" strokeWidth="1.75" strokeLinecap="round">
        <path d="M12 8.2 V5.8" />
        <path d="M6.7 10.7 L5 9" />
        <path d="M17.3 10.7 L19 9" />
        <path d="M3 16 H21" />
        <path d="M8 19.5 H16" />
      </g>
    </svg>
  );
}

// Badges (the boards' Shopify-style status): a 14 px glyph and a word, never colour alone.
export type Glyph =
  | "ring"
  | "half"
  | "check"
  | "circle"
  | "plus"
  | "clock"
  | "dots"
  | "alert"
  | "pause"
  | "minus"
  | "triangle";
// Built on call, not at import: a module-scope element would need React at load time.
function glyphShape(glyph: Glyph): ReactNode {
  const ring = <circle cx="7" cy="7" r="5.2" stroke="currentColor" strokeWidth="1.6" />;
  const glyphs: Readonly<Record<Glyph, ReactNode>> = {
    ring: (
      <circle
        cx="7"
        cy="7"
        r="5.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray="2.4 1.68"
      />
    ),
    half: (
      <>
        {ring}
        <path d="M7 3.6 A3.4 3.4 0 0 1 7 10.4 Z" fill="currentColor" />
      </>
    ),
    check: (
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
    ),
    circle: ring,
    plus: (
      <>
        {ring}
        <path d="M7 4.6 V9.4 M4.6 7 H9.4" stroke="currentColor" strokeWidth="1.6" />
      </>
    ),
    clock: (
      <>
        {ring}
        <path
          d="M7 4.4 V7 L8.8 8.2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </>
    ),
    dots: (
      <>
        {ring}
        <path
          d="M4.6 7h.01 M7 7h.01 M9.4 7h.01"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </>
    ),
    alert: (
      <>
        {ring}
        <path d="M7 4.3 V7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="9.8" r="0.95" fill="currentColor" />
      </>
    ),
    pause: (
      <>
        {ring}
        <path d="M5.8 5 V9 M8.2 5 V9" stroke="currentColor" strokeWidth="1.6" />
      </>
    ),
    minus: (
      <>
        {ring}
        <path d="M4.6 7 H9.4" stroke="currentColor" strokeWidth="1.6" />
      </>
    ),
    triangle: (
      <>
        <path
          d="M7 1.8 L12.6 11.6 H1.4 Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M7 5.4 V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="9.9" r="0.9" fill="currentColor" />
      </>
    ),
  };
  return glyphs[glyph];
}
export function BadgeGlyph({ glyph }: { readonly glyph: Glyph }) {
  return (
    <svg
      className="badge-glyph"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {glyphShape(glyph)}
    </svg>
  );
}

/**
 * Sunrise tones: caution (your turn), info (being worked on), success (done), warning (time
 * or attention), critical (confirmed failure only) and neutral. `accent` and `danger` are
 * the option 1 names, kept so a screen not yet moved renders as info and critical.
 */
export type TagTone =
  | "neutral"
  | "caution"
  | "info"
  | "success"
  | "warning"
  | "critical"
  | "accent"
  | "danger";
const toneGlyph: Readonly<Record<TagTone, Glyph>> = {
  neutral: "circle",
  caution: "ring",
  info: "half",
  success: "check",
  warning: "alert",
  critical: "triangle",
  accent: "half",
  danger: "triangle",
};
export function Tag({
  tone = "neutral",
  glyph,
  children,
}: {
  readonly tone?: TagTone;
  readonly glyph?: Glyph;
  readonly children: ReactNode;
}) {
  return (
    <span className={`tag tag-${tone}`}>
      <BadgeGlyph glyph={glyph ?? toneGlyph[tone]} />
      <span className="tag-word">{children}</span>
    </span>
  );
}

const tones: Readonly<Record<string, readonly [TagTone, Glyph]>> = {
  draft: ["neutral", "circle"],
  ready: ["info", "half"],
  queued: ["info", "half"],
  running: ["info", "half"],
  active: ["info", "half"],
  open: ["caution", "ring"],
  waiting_input: ["caution", "ring"],
  waiting_approval: ["caution", "ring"],
  paused: ["neutral", "pause"],
  cancelling: ["neutral", "minus"],
  cancelled: ["neutral", "minus"],
  expired: ["neutral", "minus"],
  answered: ["success", "check"],
  achieved: ["success", "check"],
  succeeded: ["success", "check"],
  failed: ["critical", "triangle"],
  // M2 PR-2: store installations.
  linked: ["success", "check"],
  unlinked: ["caution", "ring"],
  suspended: ["neutral", "minus"],
  uninstalled: ["neutral", "minus"],
  // M3 PR-2: runs and their products.
  pending: ["neutral", "circle"],
  in_progress: ["info", "half"],
  drafted: ["success", "check"],
  skipped: ["neutral", "minus"],
  // v1 PR 3: each product's apply. An unknown outcome is never shown as done: Checking and
  // Needs attention carry the three dots until a read-back settles them.
  authorized: ["info", "half"],
  dispatching: ["info", "half"],
  submitted: ["info", "half"],
  verifying: ["info", "dots"],
  verified: ["success", "check"],
  conflict: ["warning", "alert"],
  uncertain: ["warning", "dots"],
};
export function StatusTag({
  family,
  status,
}: {
  readonly family:
    | "task"
    | "goal"
    | "question"
    | "installation"
    | "run"
    | "runProduct"
    | "operation";
  readonly status: string;
}) {
  const [tone, glyph] = Object.hasOwn(tones, status)
    ? tones[status]!
    : (["neutral", "circle"] as const);
  return (
    <Tag tone={tone} glyph={glyph}>
      <span dir="auto">{statusLabel(family, status)}</span>
    </Tag>
  );
}

export function PersonLabel({ person }: { readonly person: PersonRef }) {
  return <span className="person-label">{personLabel(person)}</span>;
}

/** A server time, shown as an ISO date and time in UTC; never parsed beyond Date. */
export function Time({ value }: { readonly value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span dir="auto">{value}</span>;
  const text = date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return <time dateTime={date.toISOString()}>{text}</time>;
}

/** Record text: plain React text, direction from content. */
export function RecordText({
  as: Element = "span",
  className,
  children,
}: {
  readonly as?: "span" | "p" | "h1" | "h2" | "h3" | "div";
  readonly className?: string;
  readonly children: string;
}) {
  return (
    <Element dir="auto" className={className}>
      {children}
    </Element>
  );
}
