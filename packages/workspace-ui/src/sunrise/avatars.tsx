// T7 PR 16: the Sunrise characters (ADR-0032 item 3; the Sunrise brief §2.4), drawn from
// the brief's markup with every colour moved to a token class (`styles/sunrise-team.css`),
// so no colour literal lives outside tokens.css. People stay round, with initials and a
// presence word for screen readers. A face, colour or pill confers nothing.
import { useId, type ReactNode } from "react";
import type { AgentCharacter, SpecialistProp } from "../team-model";
import { sunriseCopy } from "./copy";

const body = "M5 44 C5 25 11 13 20 13 C29 13 35 25 35 44 Z";
const eyes = (y = 22.4) => (
  <>
    <circle className="sa-ink" cx="16.8" cy={y} r="1.2" />
    <circle className="sa-ink" cx="23.2" cy={y} r="1.2" />
  </>
);
const smile = (d = "M17.4 26.4 Q20 28.6 22.6 26.4") => <path className="sa-line sa-w14" d={d} />;

// Built when drawn, never at import (no element exists before React does).
const specialistProps: Readonly<Record<SpecialistProp, () => ReactNode>> = {
  calendar: () => (
    <>
      <rect className="sa-prop sa-w14" x="24.6" y="26.6" width="9.8" height="9" rx="1.6" />
      <path className="sa-line sa-w12" d="M24.6 29.6 H34.4" />
      <path className="sa-line sa-w13" d="M27.2 25.2 V27.6 M31.8 25.2 V27.6" />
      <circle className="sa-ink" cx="29.5" cy="32.6" r="1.2" />
    </>
  ),
  envelope: () => (
    <>
      <rect className="sa-prop sa-w14" x="24.2" y="27.4" width="11" height="8" rx="1.4" />
      <path className="sa-line sa-w12" d="M24.8 28.2 L29.7 31.8 L34.6 28.2" />
    </>
  ),
  magnifier: () => (
    <>
      <circle className="sa-prop sa-w14" cx="28.6" cy="30" r="3.8" />
      <path className="sa-line sa-w20" d="M31.4 32.8 L34.6 36" />
    </>
  ),
  pencil: () => (
    <>
      <path className="sa-prop sa-w13" d="M25 35.6 L25.8 32.2 L32.6 25.4 L35.2 28 L28.4 34.8 Z" />
      <path className="sa-line sa-w12" d="M31.2 26.8 L33.8 29.4" />
    </>
  ),
  chart: () => (
    <>
      <rect className="sa-prop sa-w14" x="24.4" y="26.4" width="10.4" height="9.6" rx="1.6" />
      <path className="sa-line sa-w15" d="M27 33.6 V31 M29.6 33.6 V29 M32.2 33.6 V30.2" />
    </>
  ),
};

/** The face and prop of each character, over its tile and body. */
function features(character: AgentCharacter, prop: SpecialistProp): ReactNode {
  switch (character) {
    case "morrow":
      return (
        <>
          <g className="sa-line sa-w16">
            <path d="M20 15.2 V12.2" />
            <path d="M11.7 19 L9.6 16.9" />
            <path d="M28.3 19 L30.4 16.9" />
            <path d="M7.5 27.5 H32.5" />
            <path d="M14 31.5 H26" />
          </g>
          <path className="sa-sun sa-w16" d="M11 27.5 A9 9 0 0 1 29 27.5 Z" />
          <circle className="sa-ink" cx="16.9" cy="23.2" r="1.1" />
          <circle className="sa-ink" cx="23.1" cy="23.2" r="1.1" />
          <path className="sa-line sa-w13" d="M18 25.2 Q20 26.6 22 25.2" />
        </>
      );
    case "listings":
      return (
        <>
          <circle className="sa-prop sa-w14" cx="16.2" cy="21.5" r="3.4" />
          <circle className="sa-prop sa-w14" cx="23.8" cy="21.5" r="3.4" />
          <path className="sa-line sa-w14" d="M19.6 21.3 H20.4" />
          <circle className="sa-ink" cx="16.6" cy="21.8" r="1.1" />
          <circle className="sa-ink" cx="24.2" cy="21.8" r="1.1" />
          {smile("M17.6 27.2 Q20 29.2 22.4 27.2")}
          <path
            className="sa-prop sa-w14"
            d="M25.5 28 H33.2 A1 1 0 0 1 34.2 29 V34 A1 1 0 0 1 33.2 35 H25.5 L22.8 31.5 Z"
          />
          <circle className="sa-ink" cx="26" cy="31.5" r="1" />
        </>
      );
    case "business_analyst":
      return (
        <>
          <path
            className="sa-ink"
            d="M12.6 19 C13.4 14.6 16.6 12.6 20 12.6 C23.8 12.6 26.8 14.8 27.4 19 C24.6 16.6 21.6 15.8 18.6 16 C16.4 16.2 14.4 17.2 12.6 19 Z"
          />
          {eyes()}
          {smile("M17.4 26.2 Q20 28.4 22.6 26.2")}
          <rect className="sa-prop sa-w14" x="24.6" y="25.6" width="9.6" height="11" rx="1.6" />
          <rect className="sa-ink" x="27.4" y="24.4" width="4" height="2.6" rx="0.9" />
          <path className="sa-line sa-w13" d="M26.6 34.2 L28.6 31.6 L30.2 32.8 L32.4 29.2" />
        </>
      );
    case "inventory":
      return (
        <>
          <path
            className="sa-ink"
            d="M12.4 18 C12.4 13.2 15.8 10.8 20 10.8 C24.2 10.8 27.6 13.2 27.6 18 Z"
          />
          <path className="sa-line sa-w20" d="M25.5 18 H31.2" />
          {eyes(22.6)}
          {smile()}
          <rect className="sa-box sa-w14" x="24.2" y="27" width="10.6" height="8.6" rx="1" />
          <path className="sa-line sa-w12" d="M24.2 29.8 H34.8" />
          <path className="sa-tape" d="M29.5 27 V31.6" />
        </>
      );
    case "support":
      return (
        <>
          <path className="sa-line sa-w18" d="M11.8 22 C11.8 12.6 28.2 12.6 28.2 22" />
          <rect className="sa-ink" x="9.8" y="20.2" width="4" height="6" rx="1.8" />
          <rect className="sa-ink" x="26.2" y="20.2" width="4" height="6" rx="1.8" />
          <path className="sa-line sa-w14" d="M12.2 26 Q12.8 30.4 17.2 30.4" />
          <circle className="sa-ink" cx="17.8" cy="30.4" r="1.2" />
          {eyes(22.2)}
          {smile("M17.4 25.6 Q20 27.8 22.6 25.6")}
        </>
      );
    case "marketing":
      return (
        <>
          {eyes()}
          {smile()}
          <path className="sa-prop sa-w14" d="M24.6 30 L32.6 25.8 V36.2 L24.6 32 Z" />
          <rect className="sa-ink" x="22.4" y="29.6" width="2.6" height="2.8" rx="0.8" />
          <path className="sa-line sa-w13" d="M34.8 28.4 L36.6 27.4" />
          <path className="sa-line sa-w13" d="M35.2 31 H37.2" />
        </>
      );
    case "specialist":
      return (
        <>
          <rect className="sa-edge" x="0.75" y="0.75" width="38.5" height="38.5" rx="11.25" />
          {eyes()}
          {smile()}
          {specialistProps[prop]()}
        </>
      );
  }
}

export const characterNames: Readonly<Record<AgentCharacter, string>> = {
  morrow: "Morrow",
  listings: "Listings",
  business_analyst: "Business Analyst",
  inventory: "Inventory",
  support: "Support",
  marketing: "Marketing",
  specialist: "Specialist",
};

/**
 * One agent character in its tile. `label` names it for screen readers when it is the only
 * label; where the name is printed beside it (most places), it stays hidden.
 */
export function AgentAvatar({
  character,
  size = 40,
  prop = "calendar",
  label = null,
}: {
  readonly character: AgentCharacter;
  readonly size?: number;
  readonly prop?: SpecialistProp;
  readonly label?: string | null;
}) {
  // useId gives ":r1:"-style ids; a url(#…) reference needs plain characters.
  const clip = "sa-clip-" + useId().replace(/[^A-Za-z0-9_-]/g, "");
  const a11y = label === null ? { "aria-hidden": true } : { role: "img", "aria-label": label };
  if (size < 24)
    return (
      <span
        className={`sa-initial sa-${character}`}
        style={{ width: size, height: size }}
        {...(label === null ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      >
        {characterNames[character].slice(0, 1)}
      </span>
    );
  return (
    <svg
      className={`sa sa-${character}`}
      viewBox="0 0 40 40"
      width={size}
      height={size}
      focusable="false"
      {...a11y}
    >
      <defs>
        <clipPath id={clip}>
          <rect width="40" height="40" rx="12" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect className="sa-tile" width="40" height="40" />
        {character === "morrow" ? null : <path className="sa-body sa-w16" d={body} />}
      </g>
      {features(character, prop)}
    </svg>
  );
}

/** A person: a round tile with initials, and a presence dot with its word for screen readers. */
export function PersonAvatar({
  initials,
  presence = null,
  size = 40,
}: {
  readonly initials: string;
  readonly presence?: "online" | "away" | null;
  readonly size?: number;
}) {
  return (
    <span className="sr-person" style={{ width: size, height: size }}>
      <span className="sr-person-initials" aria-hidden="true">
        {initials}
      </span>
      {presence ? (
        <>
          <span className={`sr-presence sr-presence-${presence}`} aria-hidden="true" />
          <span className="visually-hidden">{sunriseCopy.hidden[presence]}</span>
        </>
      ) : null}
    </span>
  );
}
