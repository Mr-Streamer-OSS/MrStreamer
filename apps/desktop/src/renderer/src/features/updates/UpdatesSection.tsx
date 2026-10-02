// Updates, in Settings > General: the version and where its update stands, with the one action
// it needs, then the channel, and the offered release's notes. The top bar's notice and these
// rows share the updates service's state, so an action in either shows in both. A copy the
// Microsoft Store installed gets one row instead, which opens the Store.
import type { CheckFailure, UpdateStatus } from "@mrstreamer/contracts/updates";
import type { Channel } from "@mrstreamer/contracts/version";
import { Button } from "../../components/ui/button.tsx";
import { Row, Section, Select } from "../settings/Rows.tsx";
import { noteItems } from "./notes.ts";
import { useUpdates } from "./use-updates.ts";

const RELEASES_URL = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases";

const CHANNELS: readonly { value: Channel; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
];

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** Why a check found nothing, in a few words. */
function describeCheckFailure(failure: CheckFailure): string {
  switch (failure.kind) {
    case "offline":
      return "You seem to be offline.";
    case "busy":
      return failure.until
        ? `GitHub is limiting requests until ${time.format(failure.until)}.`
        : "GitHub is limiting requests for now.";
    case "http":
      return `The update server answered HTTP ${failure.status}.`;
    case "invalid":
      return "The update server sent something unexpected.";
  }
}

export function UpdatesSection() {
  const { status, setChannel, openStore } = useUpdates();
  if (!status) return null;
  // The Microsoft Store updates a copy it installed, and carries one release line.
  if (status.distribution === "store") {
    return (
      <Section title="Updates">
        <Row label={status.version} note="updated by the Microsoft Store">
          <Button size="sm" onClick={openStore}>
            Open Store
          </Button>
        </Row>
      </Section>
    );
  }
  return (
    <Section title="Updates">
      <State status={status} />
      <Row
        label="Channel"
        note={
          status.channel === "nightly"
            ? "newest builds, and every stable release"
            : "tested releases"
        }
      >
        <Select label="Channel" value={status.channel} options={CHANNELS} onChange={setChannel} />
      </Row>
      <Notes status={status} />
    </Section>
  );
}

/** The version, where its update stands, and the one action that needs. */
function State({ status }: { status: UpdateStatus }) {
  const { check, download, cancel, restart } = useUpdates();
  const { update, version, checked, nextCheckAt, offer } = status;
  let note: string;
  switch (update.kind) {
    case "idle":
      note = nextCheckAt ? `checks at ${time.format(nextCheckAt)}` : "not checked yet";
      break;
    case "checking":
      note = "checking…";
      break;
    case "current":
      note = checked ? `up to date, checked ${time.format(checked.at)}` : "up to date";
      break;
    case "available":
      note = `${update.version} is available`;
      break;
    case "downloading":
      note = `downloading ${update.version}, ${update.percent} %`;
      break;
    case "ready":
      note = `${update.version} is ready; playback stops for a moment while it restarts`;
      break;
    case "failed":
      note =
        update.step === "check"
          ? "couldn't check"
          : update.step === "download"
            ? `the download of ${update.version} stopped`
            : `${update.version} couldn't be installed`;
      break;
  }
  const failure =
    update.kind === "failed"
      ? update.step === "check"
        ? describeCheckFailure(update.failure)
        : update.detail
      : null;
  // An automatic check that failed keeps the last result on screen, and says so quietly.
  const quietFailure =
    checked?.failure && update.kind !== "failed" && update.kind !== "checking"
      ? `The last check failed at ${time.format(checked.at)}: ${describeCheckFailure(checked.failure)}${nextCheckAt ? ` Trying again at ${time.format(nextCheckAt)}.` : ""}`
      : null;
  const busy = update.kind === "downloading" || update.kind === "ready";
  const offered = update.kind === "available" || update.kind === "failed" || busy;
  return (
    <>
      <Row label={version} note={note}>
        {offered && (
          <Button
            variant="ghost"
            size="sm"
            render={<a href={offer?.page ?? RELEASES_URL} target="_blank" rel="noreferrer" />}
          >
            GitHub ›
          </Button>
        )}
        {update.kind === "available" && (
          <Button variant="primary" size="sm" onClick={download}>
            Download
          </Button>
        )}
        {update.kind === "downloading" && (
          <Button size="sm" onClick={cancel}>
            Cancel
          </Button>
        )}
        {update.kind === "ready" && (
          <Button variant="primary" size="sm" onClick={restart}>
            Restart to update
          </Button>
        )}
        {update.kind === "failed" && update.step !== "check" && (
          <Button variant="primary" size="sm" onClick={download}>
            Try again
          </Button>
        )}
        {/* Checking stays at hand beside an offer: a newer release may be out since. */}
        {!busy && (
          <Button
            variant={update.kind === "available" ? "ghost" : "secondary"}
            size="sm"
            disabled={update.kind === "checking"}
            onClick={check}
          >
            {update.kind === "checking" ? "Checking…" : "Check now"}
          </Button>
        )}
      </Row>
      {update.kind === "downloading" && (
        <div className="h-0.5 overflow-hidden bg-white/12">
          <div className="h-full bg-white" style={{ width: `${update.percent}%` }} />
        </div>
      )}
      {failure && <p className="mt-2 text-sm text-destructive">{failure}</p>}
      {quietFailure && (
        <p className="mt-2 text-[0.8125rem] text-muted-foreground">{quietFailure}</p>
      )}
    </>
  );
}

/** What's new in the offered release, each change linked to its pull request. */
function Notes({ status }: { status: UpdateStatus }) {
  const { offer } = status;
  const items = noteItems(offer?.notes ?? null);
  if (!offer || items.length === 0) return null;
  return (
    <div className="mt-5">
      <h3 className="text-[0.9375rem] font-medium">What's new in {offer.version}</h3>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[0.9375rem] text-foreground/85">
        {items.map((item) => (
          <li key={item.text}>
            {item.text}
            {item.url && (
              <>
                {" "}
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline-offset-4 hover:text-white hover:underline"
                >
                  {item.label}
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
