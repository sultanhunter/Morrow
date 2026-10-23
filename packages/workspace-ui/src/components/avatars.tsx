// The Sunrise agent characters (ADR-0032 item 3; the design brief's section 2): each agent
// is a simple face with one head feature and one prop for its job, in a rounded tile of
// its own colour, followed by an "Agent" pill wherever the page doesn't already say it.
// People stay round (initials here, with a presence dot and hidden text). A face, colour,
// pill or title confers no authority: these are pictures only.
//
// Colours come from tokens.css through classes (no literal here). Every clip path id is
// unique per use (useId), so many avatars can share a page.
import { useId, type ReactNode } from "react";
import type { AgentKind } from "../model";

export type SpecialistProp = "calendar" | "envelope" | "magnifier" | "pencil" | "chart";

/** Display names. "Morrow" is the Coordinator as merchants see it. */
export const agentNames: Readonly<Record<Exclude<AgentKind, "specialist">, string>> = {
  morrow: "Morrow",
  listings: "Listings",
  analyst: "Business Analyst",
  inventory: "Inventory",
  support: "Support",
  marketing: "Marketing",
};
const initials: Readonly<Record<AgentKind, string>> = {
  morrow: "M",
  listings: "L",
  analyst: "B",
  inventory: "I",
  support: "S",
  marketing: "M",
  specialist: "S",
};

// Shared shapes (viewBox 40 × 40).
const body = "M5 44 C5 25 11 13 20 13 C29 13 35 25 35 44 Z";
function Eyes({ y = 22.4 }: { readonly y?: number }) {
  return (
    <>
      <circle className="av-ink" cx="16.8" cy={y} r="1.2" />
      <circle className="av-ink" cx="23.2" cy={y} r="1.2" />
    </>
  );
}
function Smile({ d = "M17.4 26.4 Q20 28.6 22.6 26.4" }: { readonly d?: string }) {
  return <path className="av-line" d={d} strokeWidth="1.4" strokeLinecap="round" />;
}
function Figure({ clip, children }: { readonly clip: string; readonly children?: ReactNode }) {
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect width="40" height="40" rx="12" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect className="av-tile" width="40" height="40" />
        <path className="av-body" d={body} strokeWidth="1.6" />
      </g>
      {children}
    </>
  );
}

const props: Readonly<Record<SpecialistProp, ReactNode>> = {
  calendar: (
    <>
      <rect
        className="av-white"
        x="24.6"
        y="26.6"
        width="9.8"
        height="9"
        rx="1.6"
        strokeWidth="1.4"
      />
      <path className="av-line" d="M24.6 29.6 H34.4" strokeWidth="1.2" />
      <path
        className="av-line"
        d="M27.2 25.2 V27.6 M31.8 25.2 V27.6"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle className="av-ink" cx="29.5" cy="32.6" r="1.2" />
    </>
  ),
  envelope: (
    <>
      <rect
        className="av-white"
        x="24.2"
        y="27.4"
        width="11"
        height="8"
        rx="1.4"
        strokeWidth="1.4"
      />
      <path
        className="av-line"
        d="M24.8 28.2 L29.7 31.8 L34.6 28.2"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </>
  ),
  magnifier: (
    <>
      <circle className="av-white" cx="28.6" cy="30" r="3.8" strokeWidth="1.4" />
      <path className="av-line" d="M31.4 32.8 L34.6 36" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  pencil: (
    <>
      <path
        className="av-white"
        d="M25 35.6 L25.8 32.2 L32.6 25.4 L35.2 28 L28.4 34.8 Z"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path className="av-line" d="M31.2 26.8 L33.8 29.4" strokeWidth="1.2" />
    </>
  ),
  chart: (
    <>
      <rect
        className="av-white"
        x="24.4"
        y="26.4"
        width="10.4"
        height="9.6"
        rx="1.6"
        strokeWidth="1.4"
      />
      <path
        className="av-line"
        d="M27 33.6 V31 M29.6 33.6 V29 M32.2 33.6 V30.2"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
};

function Drawing({
  agent,
  clip,
  prop,
}: {
  readonly agent: AgentKind;
  readonly clip: string;
  readonly prop: SpecialistProp;
}) {
  switch (agent) {
    case "morrow":
      return (
        <>
          <rect className="av-tile" width="40" height="40" rx="12" />
          <g className="av-line" strokeWidth="1.6" strokeLinecap="round">
            <path d="M20 15.2 V12.2" />
            <path d="M11.7 19 L9.6 16.9" />
            <path d="M28.3 19 L30.4 16.9" />
            <path d="M7.5 27.5 H32.5" />
            <path d="M14 31.5 H26" />
          </g>
          <path
            className="av-sun"
            d="M11 27.5 A9 9 0 0 1 29 27.5 Z"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle className="av-ink" cx="16.9" cy="23.2" r="1.1" />
          <circle className="av-ink" cx="23.1" cy="23.2" r="1.1" />
          <path
            className="av-line"
            d="M18 25.2 Q20 26.6 22 25.2"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </>
      );
    case "listings":
      return (
        <Figure clip={clip}>
          <circle className="av-white" cx="16.2" cy="21.5" r="3.4" strokeWidth="1.4" />
          <circle className="av-white" cx="23.8" cy="21.5" r="3.4" strokeWidth="1.4" />
          <path className="av-line" d="M19.6 21.3 H20.4" strokeWidth="1.4" />
          <circle className="av-ink" cx="16.6" cy="21.8" r="1.1" />
          <circle className="av-ink" cx="24.2" cy="21.8" r="1.1" />
          <Smile d="M17.6 27.2 Q20 29.2 22.4 27.2" />
          <path
            className="av-white"
            d="M25.5 28 H33.2 A1 1 0 0 1 34.2 29 V34 A1 1 0 0 1 33.2 35 H25.5 L22.8 31.5 Z"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <circle className="av-ink" cx="26" cy="31.5" r="1" />
        </Figure>
      );
    case "analyst":
      return (
        <Figure clip={clip}>
          <path
            className="av-ink"
            d="M12.6 19 C13.4 14.6 16.6 12.6 20 12.6 C23.8 12.6 26.8 14.8 27.4 19 C24.6 16.6 21.6 15.8 18.6 16 C16.4 16.2 14.4 17.2 12.6 19 Z"
          />
          <Eyes />
          <Smile d="M17.4 26.2 Q20 28.4 22.6 26.2" />
          <rect
            className="av-white"
            x="24.6"
            y="25.6"
            width="9.6"
            height="11"
            rx="1.6"
            strokeWidth="1.4"
          />
          <rect className="av-ink" x="27.4" y="24.4" width="4" height="2.6" rx="0.9" />
          <path
            className="av-line"
            d="M26.6 34.2 L28.6 31.6 L30.2 32.8 L32.4 29.2"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Figure>
      );
    case "inventory":
      return (
        <Figure clip={clip}>
          <path
            className="av-ink"
            d="M12.4 18 C12.4 13.2 15.8 10.8 20 10.8 C24.2 10.8 27.6 13.2 27.6 18 Z"
          />
          <path className="av-line" d="M25.5 18 H31.2" strokeWidth="2" strokeLinecap="round" />
          <Eyes y={22.6} />
          <Smile />
          <rect
            className="av-prop"
            x="24.2"
            y="27"
            width="10.6"
            height="8.6"
            rx="1"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path className="av-line" d="M24.2 29.8 H34.8" strokeWidth="1.2" />
          <path className="av-tape" d="M29.5 27 V31.6" strokeWidth="1.6" />
        </Figure>
      );
    case "support":
      return (
        <Figure clip={clip}>
          <path
            className="av-line"
            d="M11.8 22 C11.8 12.6 28.2 12.6 28.2 22"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <rect className="av-ink" x="9.8" y="20.2" width="4" height="6" rx="1.8" />
          <rect className="av-ink" x="26.2" y="20.2" width="4" height="6" rx="1.8" />
          <path
            className="av-line"
            d="M12.2 26 Q12.8 30.4 17.2 30.4"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle className="av-ink" cx="17.8" cy="30.4" r="1.2" />
          <Eyes y={22.2} />
          <Smile d="M17.4 25.6 Q20 27.8 22.6 25.6" />
        </Figure>
      );
    case "marketing":
      return (
        <Figure clip={clip}>
          <Eyes />
          <Smile />
          <path
            className="av-white"
            d="M24.6 30 L32.6 25.8 V36.2 L24.6 32 Z"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <rect className="av-ink" x="22.4" y="29.6" width="2.6" height="2.8" rx="0.8" />
          <path
            className="av-line"
            d="M34.8 28.4 L36.6 27.4"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <path className="av-line" d="M35.2 31 H37.2" strokeWidth="1.3" strokeLinecap="round" />
        </Figure>
      );
    case "specialist":
      return (
        <Figure clip={clip}>
          <rect
            className="av-edge"
            x="0.75"
            y="0.75"
            width="38.5"
            height="38.5"
            rx="11.25"
            strokeWidth="1.5"
            strokeDasharray="3 2.5"
          />
          <Eyes />
          <Smile />
          {props[prop]}
        </Figure>
      );
  }
}

/**
 * One agent character. `label` set: the avatar is the only label (role="img"); otherwise
 * it is decorative, because the name is printed beside it. Below 24 px the tile shows the
 * agent's initial instead of the drawing.
 */
export function AgentAvatar({
  agent,
  size = 40,
  label,
  prop = "calendar",
}: {
  readonly agent: AgentKind;
  readonly size?: number;
  readonly label?: string;
  readonly prop?: SpecialistProp;
}) {
  const clip = `sa-${agent}-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const labelled = label !== undefined && label !== "";
  if (size < 24)
    return (
      <span
        className="avatar avatar-agent avatar-initial"
        data-agent={agent}
        data-size={size}
        {...(labelled ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      >
        {initials[agent]}
      </span>
    );
  return (
    <svg
      className="avatar avatar-agent"
      data-agent={agent}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      focusable="false"
      {...(labelled ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <Drawing agent={agent} clip={clip} prop={prop} />
    </svg>
  );
}

/** "Agent", in the agent's own colours; screen readers hear ", agent". */
export function AgentPill({ agent }: { readonly agent: AgentKind }) {
  if (agent === "specialist") return <SpecialistPill />;
  return (
    <span className="agent-pill" data-agent={agent}>
      <span className="visually-hidden">, </span>Agent
    </span>
  );
}
/** A specialist's neutral pill; screen readers hear ", specialist, one-time". */
export function SpecialistPill() {
  return (
    <span className="agent-pill" data-agent="specialist">
      <span className="visually-hidden">, specialist, one-time</span>
      <span aria-hidden="true">Specialist · one-time</span>
    </span>
  );
}

/** An agent's name followed by its pill (the byline pattern). */
export function AgentName({ agent, name }: { readonly agent: AgentKind; readonly name?: string }) {
  const shown = name ?? (agent === "specialist" ? "Specialist" : agentNames[agent]);
  return (
    <span className="agent-name">
      <span className="agent-name-text" dir="auto">
        {shown}
      </span>
      <AgentPill agent={agent} />
    </span>
  );
}

/** Up to two letters for a person's round avatar. */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return letters.map((w) => [...w][0]?.toUpperCase() ?? "").join("");
}

/** A person: a round avatar with initials and, when known, a presence dot plus hidden text. */
export function PersonAvatar({
  name,
  size = 28,
  presence = null,
}: {
  readonly name: string;
  readonly size?: number;
  readonly presence?: "online" | "away" | null;
}) {
  return (
    <span className="avatar avatar-person" data-size={size} aria-hidden="true">
      {personInitials(name)}
      {presence ? <span className="presence" data-presence={presence} /> : null}
    </span>
  );
}

/**
 * The store's own mark: a monogram on a warm tile, set in a serif (the shop's logo stays
 * the shop's). "Linen & Form" becomes "L&F".
 */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const marks = words.map((w) => (w === "&" || w === "+" ? w : ([...w][0] ?? "")));
  const letters = marks.filter((m) => m !== "&" && m !== "+");
  if (letters.length <= 1) return (letters[0] ?? "").toUpperCase();
  return marks.slice(0, 3).join("").toUpperCase();
}
export function StoreTile({ name, size = 36 }: { readonly name: string; readonly size?: number }) {
  return (
    <span className="store-tile" data-size={size} aria-hidden="true">
      {monogram(name)}
    </span>
  );
}
