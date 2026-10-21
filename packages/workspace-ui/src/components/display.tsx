// Display primitives: icons (aria-hidden inline SVG), tags, opaque person labels and
// times. Record text always renders as React text with dir="auto".
import type { ReactNode } from "react";
import { statusLabel } from "../copy";
import { personLabel, type PersonRef } from "../model";

const paths = {
  home: ["m3 10 9-7 9 7v10H3z", "M9 20v-7h6v7"],
  work: ["M3 6h7l2 2h9v12H3z"],
  inbox: ["M5 4h14l3 12v4H2v-4z", "M3 15h5l2 3h4l2-3h5"],
  agents: ["M8 7h8a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4z", "M12 3v4"],
  assets: [
    "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z",
    "m4 18 5-6 4 3 4-5 4 6",
  ],
  knowledge: ["M4 3h7v17H4z", "M13 3h7v17h-7z"],
  settings: ["M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z", "M12 2v3 M12 19v3 M2 12h3 M19 12h3"],
  menu: ["M3 6h18 M3 12h18 M3 18h18"],
  close: ["m6 6 12 12 M6 18 18 6"],
  check: ["m5 12 4 4L19 6"],
  chevron: ["m6 9 6 6 6-6"],
  forward: ["m9 6 6 6-6 6"],
  document: ["M5 2h9l5 5v15H5z", "M14 2v6h5"],
} as const;
export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
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

export type TagTone = "neutral" | "accent" | "success" | "warning" | "danger";
export function Tag({
  tone = "neutral",
  children,
}: {
  readonly tone?: TagTone;
  readonly children: ReactNode;
}) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

const tones: Readonly<Record<string, TagTone>> = {
  draft: "neutral",
  ready: "accent",
  queued: "accent",
  running: "accent",
  active: "accent",
  open: "warning",
  waiting_input: "warning",
  waiting_approval: "warning",
  paused: "warning",
  answered: "success",
  achieved: "success",
  succeeded: "success",
  failed: "danger",
  // M2 PR-2: store installations.
  linked: "success",
  unlinked: "warning",
  suspended: "warning",
  uninstalled: "danger",
};
export function StatusTag({
  family,
  status,
}: {
  readonly family: "task" | "goal" | "question" | "installation";
  readonly status: string;
}) {
  return (
    <Tag tone={Object.hasOwn(tones, status) ? tones[status]! : "neutral"}>
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
