// The Updates tab of Settings: where the update stands in one line, the action it needs, then the
// release notes and the channel. The top bar's notice and this tab share the updates service's
// state, so an action in either shows in both.
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { CheckFailure, UpdateStatus } from "@mrstreamer/contracts/updates";
import type { Channel } from "@mrstreamer/contracts/version";
import { Button } from "../../components/ui/button.tsx";
import { noteItems } from "./notes.ts";
import { useUpdates } from "./use-updates.ts";

const RELEASES_URL = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases";

const CHANNELS: readonly { value: Channel; label: string; hint: string }[] = [
  { value: "stable", label: "Stable", hint: "Tested releases" },
  { value: "nightly", label: "Nightly", hint: "Newest builds, and every stable release" },
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
  const { status, setChannel } = useUpdates();
  if (!status) return null;
  return (
    <section>
      <State status={status} />
      <Notes status={status} />
      <h2 className="mt-10 text-[0.9375rem] font-semibold">Channel</h2>
      <RadioGroup
        value={status.channel}
        onValueChange={(value) => {
          if (value === "stable" || value === "nightly") setChannel(value);
        }}
        className="mt-2"
      >
        {CHANNELS.map((channel) => (
          <label key={channel.value} className="flex items-center gap-3 py-1.5 text-[0.9375rem]">
            <Radio.Root
              value={channel.value}
              className="size-4 flex-none rounded-full shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring data-checked:shadow-[inset_0_0_0_5px_#fff]"
            />
            <span>
              {channel.label} <span className="text-muted-foreground">· {channel.hint}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </section>
  );
}

/** The headline, what it means, and the one action it needs. */
function State({ status }: { status: UpdateStatus }) {
  const { check, download, cancel, restart } = useUpdates();
  const { update, version, channel, checked, nextCheckAt, offer } = status;
  const channelName = channel === "nightly" ? "Nightly" : "Stable";
  const checkedLine = checked ? `checked ${time.format(checked.at)}` : "not checked yet";
  const installed = `You have ${version} · ${channelName} · ${checkedLine}`;
  let headline: string;
  let line = installed;
  switch (update.kind) {
    case "idle":
      headline = `Mr. Streamer ${version}`;
      line = `${channelName} · ${nextCheckAt ? `checks at ${time.format(nextCheckAt)}` : checkedLine}`;
      break;
    case "checking":
      headline = "Checking for updates…";
      break;
    case "current":
      headline = "Mr. Streamer is up to date";
      line = `${version} · ${channelName} · ${checkedLine}`;
      break;
    case "available":
      headline = `${update.version} is available`;
      break;
    case "downloading":
      headline = `Downloading ${update.version}`;
      break;
    case "ready":
      headline = `${update.version} is ready to install`;
      line = "Playback stops for a moment while Mr. Streamer restarts.";
      break;
    case "failed":
      headline =
        update.step === "check"
          ? "Couldn't check for updates"
          : update.step === "download"
            ? `The download of ${update.version} stopped`
            : `${update.version} couldn't be installed`;
      line = update.step === "check" ? describeCheckFailure(update.failure) : update.detail;
      break;
  }
  // An automatic check that failed keeps the last result on screen, and says so quietly.
  const quietFailure =
    checked?.failure && update.kind !== "failed" && update.kind !== "checking"
      ? `The last check failed at ${time.format(checked.at)}: ${describeCheckFailure(checked.failure)}${nextCheckAt ? ` Trying again at ${time.format(nextCheckAt)}.` : ""}`
      : null;
  const busy = update.kind === "downloading" || update.kind === "ready";
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{headline}</h2>
      <p
        className={
          update.kind === "failed"
            ? "mt-1 text-sm text-destructive"
            : "mt-1 text-[0.9375rem] text-muted-foreground"
        }
      >
        {line}
      </p>
      {quietFailure && (
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">{quietFailure}</p>
      )}
      {update.kind === "downloading" && (
        <div className="mt-4 max-w-[28rem]">
          <div className="h-1 overflow-hidden rounded-full bg-white/12">
            <div className="h-full bg-white" style={{ width: `${update.percent}%` }} />
          </div>
          <div className="mt-1.5 text-[0.8125rem] text-muted-foreground">{update.percent} %</div>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {update.kind === "available" && (
          <Button variant="primary" onClick={download}>
            Download
          </Button>
        )}
        {update.kind === "downloading" && <Button onClick={cancel}>Cancel</Button>}
        {update.kind === "ready" && (
          <Button variant="primary" onClick={restart}>
            Restart to update
          </Button>
        )}
        {update.kind === "failed" && update.step !== "check" && (
          <Button variant="primary" onClick={download}>
            Try again
          </Button>
        )}
        {!busy && (
          <Button
            variant={update.kind === "available" ? "ghost" : "secondary"}
            disabled={update.kind === "checking"}
            onClick={check}
          >
            {update.kind === "checking" ? "Checking…" : "Check now"}
          </Button>
        )}
        <Button
          variant="ghost"
          render={<a href={offer?.page ?? RELEASES_URL} target="_blank" rel="noreferrer" />}
        >
          Download from GitHub ›
        </Button>
      </div>
    </div>
  );
}

/** What's new in the offered release, each change linked to its pull request. */
function Notes({ status }: { status: UpdateStatus }) {
  const { offer } = status;
  const items = noteItems(offer?.notes ?? null);
  if (!offer || items.length === 0) return null;
  return (
    <div className="mt-10">
      <h2 className="text-[0.9375rem] font-semibold">What's new in {offer.version}</h2>
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
