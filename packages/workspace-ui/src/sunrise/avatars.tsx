// T7 PR 16: the Sunrise characters on Team, agent pages, Add agents, Settings and Files.
// They are PR 14's drawings (components/avatars.tsx, ADR-0032 item 3), named by this PR's
// view models' `AgentCharacter`, so the sidebar, Home and these pages show one set of
// faces. People stay round, with initials and a presence word for screen readers. A face,
// colour or pill confers nothing.
import { AgentAvatar as Character } from "../components/avatars";
import type { AgentKind } from "../model";
import type { AgentCharacter, SpecialistProp } from "../team-model";
import { sunriseCopy } from "./copy";

/** The view models' character names onto the shell's (the Business Analyst is `analyst`). */
export const characterKind: Readonly<Record<AgentCharacter, AgentKind>> = {
  morrow: "morrow",
  listings: "listings",
  business_analyst: "analyst",
  inventory: "inventory",
  support: "support",
  marketing: "marketing",
  specialist: "specialist",
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
  return (
    <Character
      agent={characterKind[character]}
      size={size}
      prop={prop}
      {...(label === null ? {} : { label })}
    />
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
    <>
      <span
        className="avatar avatar-person"
        data-size={size}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {initials}
        {presence ? <span className="presence" data-presence={presence} /> : null}
      </span>
      {presence ? <span className="visually-hidden">{sunriseCopy.hidden[presence]}</span> : null}
    </>
  );
}
