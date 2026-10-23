// T7 PR 16: Settings > Notifications (the SettingsNotifications board): where Morrow reaches
// the person, what it emails them about, quiet hours and the shop's time zone. These are the
// viewer's own choices (everyone chooses their own); only the Owner changes the time zone,
// and the server (here the fixture) refuses it from anyone else. Every choice is a closed
// value (on or off, or one of the board's hours or zones). Emails hold counts and links
// only. Fixture data only in this build: the HTTP methods are uncomposed and send nothing.
import { useEffect, useId, useState } from "react";
import { Button } from "../components/controls";
import { outcomeState } from "../components/feedback";
import type { WorkspaceView } from "../model";
import { useCommand, useDirty, useRead, useServices } from "../services";
import {
  emailTopics,
  quietFromHours,
  quietUntilHours,
  sameNotificationChoices,
  shopTimeZones,
  summaryHours,
  type EmailTopic,
  type NotificationChoices,
  type NotificationsView,
  type ShopTimeZone,
} from "../team-model";
import { sunriseCopy } from "../sunrise/copy";
import { Card, SrIcon } from "../sunrise/parts";
import { CommandFeedback } from "./entry";
import { SettingsFrame } from "./settings-pages";

const n = sunriseCopy.notifications;
const choicesOf = (view: NotificationsView): NotificationChoices => ({
  email: view.email,
  summaryHour: view.summaryHour,
  quiet: view.quiet,
  timeZone: view.timeZone,
});

/** An on/off switch: a real button with role="switch", its state also written out. */
function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="sr-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="sr-switch-track" aria-hidden="true">
        <span className="sr-switch-knob" />
      </span>
      <span className="sr-switch-text" aria-hidden="true">
        {checked ? n.on : n.off}
      </span>
    </button>
  );
}

function HourSelect({
  label,
  hours,
  value,
  disabled,
  onChange,
  inline = false,
}: {
  readonly label: string;
  readonly hours: readonly number[];
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (hour: number) => void;
  readonly inline?: boolean;
}) {
  const id = useId();
  return (
    <div className={inline ? "sr-inline-field" : "sr-field"}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="sr-select sr-select-short"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const hour = Number(event.target.value);
          if (hours.includes(hour)) onChange(hour);
        }}
      >
        {hours.map((h) => (
          <option key={h} value={h}>
            {n.hour(h)}
          </option>
        ))}
      </select>
    </div>
  );
}

function NotificationsBody({
  workspaceId,
  shopName,
  view,
  reload,
}: {
  readonly workspaceId: string;
  readonly shopName: string;
  readonly view: NotificationsView;
  readonly reload: () => void;
}) {
  const services = useServices();
  const zoneId = useId();
  const saved = choicesOf(view);
  const [draft, setDraft] = useState<NotificationChoices | null>(null);
  // A new revision (a save confirmed, or a conflict reread) starts from what the server says.
  useEffect(() => setDraft(null), [view.revision]);
  const value = draft ?? saved;
  const dirty = !sameNotificationChoices(value, saved);
  useDirty(dirty);
  const save = useCommand<NotificationChoices & { expectedRevision: number }, { revision: number }>(
    {
      marker: null,
      send: (c) => services.port.settings.reviseNotifications(workspaceId, c),
      onOutcome: (outcome) => {
        if (outcome.kind === "ok" || (outcome.kind === "conflict" && outcome.recheck)) reload();
      },
    },
  );
  const busy = save.busy;
  const change = (next: Partial<NotificationChoices>) => {
    // A settled reply belongs to the last save; a new choice starts a new one. (Every control
    // is disabled while a save is out or its outcome unknown, so no key is dropped here.)
    if (!busy && save.phase.phase === "settled") save.reset();
    setDraft({ ...value, ...next });
  };
  const setEmail = (topic: EmailTopic, on: boolean) =>
    change({ email: { ...value.email, [topic]: on } });
  const total =
    view.morning.toReview + view.morning.questions + view.morning.tasks + view.morning.alerts;
  const zoneName = n.zones[value.timeZone] ?? value.timeZone;
  return (
    <>
      <Card title={n.where}>
        <dl className="sr-pairs sr-pairs-wide">
          <div>
            <dt>{n.inMorrow}</dt>
            <dd>{n.inMorrowValue}</dd>
          </div>
          <div>
            <dt>{n.email}</dt>
            <dd>
              <span className="sr-block sr-address-text" dir="auto">
                {view.signInEmail}
              </span>
              <span className="sr-help sr-block">{n.emailHint}</span>
            </dd>
          </div>
          <div>
            <dt>{n.phone}</dt>
            <dd>{n.phoneValue}</dd>
          </div>
        </dl>
      </Card>
      <Card title={n.what} flush>
        <div className="sr-table-scroll" role="region" aria-label={n.what} tabIndex={0}>
          <table className="sr-table sr-notify-table">
            <thead>
              <tr>
                <th scope="col">{n.columns.what}</th>
                <th scope="col">{n.columns.inMorrow}</th>
                <th scope="col">{n.columns.byEmail}</th>
              </tr>
            </thead>
            <tbody>
              {emailTopics.map((topic) => {
                const t = n.topics[topic]!;
                const on = value.email[topic];
                const note =
                  topic === "monday" && !on ? n.mondayOff : topic === "soon" ? t.note : "";
                return (
                  <tr key={topic}>
                    <th scope="row">
                      <span className="sr-row-title sr-block">{t.title}</span>
                      <span className="sr-meta sr-block">{t.about}</span>
                    </th>
                    <td>{t.inMorrow}</td>
                    <td>
                      <Switch
                        checked={on}
                        label={t.switchLabel}
                        disabled={busy}
                        onChange={(next) => setEmail(topic, next)}
                      />
                      {note ? <span className="sr-meta sr-block">{note}</span> : null}
                      {topic === "summary" && on ? (
                        <HourSelect
                          label={n.sendAt}
                          hours={summaryHours}
                          value={value.summaryHour}
                          disabled={busy}
                          inline
                          onChange={(summaryHour) => change({ summaryHour })}
                        />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <th scope="row">
                  <span className="sr-row-title sr-block">{n.everythingElse}</span>
                  <span className="sr-meta sr-block">{n.everythingElseAbout}</span>
                </th>
                <td>{n.inActivity}</td>
                <td>{n.neverByEmail}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
      <Card
        title={n.quiet}
        action={
          <Switch
            checked={value.quiet.on}
            label={n.quiet}
            disabled={busy}
            onChange={(on) => change({ quiet: { ...value.quiet, on } })}
          />
        }
      >
        <p className="sr-reading">{n.quietAbout}</p>
        {value.quiet.on ? (
          <>
            <div className="sr-field-row">
              <HourSelect
                label={n.from}
                hours={quietFromHours}
                value={value.quiet.from}
                disabled={busy}
                onChange={(from) => change({ quiet: { ...value.quiet, from } })}
              />
              <HourSelect
                label={n.until}
                hours={quietUntilHours}
                value={value.quiet.until}
                disabled={busy}
                onChange={(until) => change({ quiet: { ...value.quiet, until } })}
              />
            </div>
            <p className="sr-help">{n.everyDay(zoneName)}</p>
          </>
        ) : null}
      </Card>
      <Card title={n.timeZone}>
        <div className="sr-field sr-field-narrow">
          <label htmlFor={zoneId}>{n.timeZoneLabel(shopName)}</label>
          <select
            id={zoneId}
            className="sr-select"
            value={value.timeZone}
            disabled={busy || !view.canChangeTimeZone}
            aria-describedby={`${zoneId}-hint`}
            onChange={(event) => {
              const zone = shopTimeZones.find((z) => z === event.target.value);
              if (zone) change({ timeZone: zone as ShopTimeZone });
            }}
          >
            {shopTimeZones.map((zone) => (
              <option key={zone} value={zone}>
                {n.zones[zone]}
              </option>
            ))}
          </select>
          <small id={`${zoneId}-hint`} className="sr-help">
            {n.timeZoneHint(shopName)}
          </small>
        </div>
        {view.canChangeTimeZone ? null : (
          <p className="sr-help sr-with-icon">
            <SrIcon name="lock" size={16} />
            {n.timeZoneOwner(view.ownerName)}
          </p>
        )}
      </Card>
      <Card title={n.preview}>
        {value.email.summary ? (
          <div className="sr-mail-preview">
            <p className="sr-meta">{n.previewFrom(n.hour(value.summaryHour))}</p>
            <p className="sr-row-title" dir="auto">
              {n.previewSubject(shopName, total)}
            </p>
            <ul className="sr-bullets">
              <li>{n.previewLines.toReview(view.morning.toReview)}</li>
              <li>{n.previewLines.questions(view.morning.questions)}</li>
              <li>{n.previewLines.tasks(view.morning.tasks)}</li>
              <li>{n.previewLines.alerts(view.morning.alerts)}</li>
            </ul>
            <p className="sr-link-text" aria-hidden="true">
              {n.previewOpen}
            </p>
            <p className="sr-help">{n.previewWhy}</p>
          </div>
        ) : (
          <p className="sr-help">{n.previewOff}</p>
        )}
      </Card>
      {dirty || busy || save.phase.phase !== "idle" ? (
        <div className="sr-save-bar" role="region" aria-label={n.unsaved}>
          {dirty ? <p className="sr-row-title">{n.unsaved}</p> : null}
          <div className="sr-save-feedback">
            <CommandFeedback
              phase={save.phase}
              onCheckAgain={() => void save.checkAgain()}
              onRetry={() => void save.retry()}
              success={n.saved}
              messages={{ conflict: (o) => (o.recheck ? n.changed : o.message) }}
            />
          </div>
          {dirty ? (
            <div className="sr-form-actions">
              <Button
                onClick={() => {
                  setDraft(null);
                  save.reset();
                }}
                disabled={busy}
              >
                {n.discard}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void save.submit({ ...value, expectedRevision: view.revision })}
              >
                {busy ? n.saving : n.save}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function NotificationsScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [prefs, reload] = useRead(`${ws}|settings.notifications`, () =>
    services.port.settings.notifications(ws),
  );
  return (
    <SettingsFrame
      workspaceId={ws}
      current="notifications"
      title={n.title}
      scope={
        prefs.kind === "ok"
          ? n.intro(prefs.value.viewerName, workspace.displayName)
          : sunriseCopy.settings.items.notifications.about
      }
    >
      {prefs.kind === "ok" ? (
        <NotificationsBody
          workspaceId={ws}
          shopName={workspace.displayName}
          view={prefs.value}
          reload={reload}
        />
      ) : (
        outcomeState(prefs, reload)
      )}
    </SettingsFrame>
  );
}
