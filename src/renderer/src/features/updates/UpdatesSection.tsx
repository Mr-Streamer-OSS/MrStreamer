// Updates in the Settings sheet: the installed version, the channel, and the one action that
// fits the current state. Downloads and restarts only happen when the user starts them.
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import type { UpdateStatus } from "../../../../shared/updates.ts";
import { channelOf, parseVersion, type Channel } from "../../../../shared/version.ts";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { useUpdates } from "./use-updates.ts";

const CHANNELS: readonly { value: Channel; label: string; hint: string }[] = [
  { value: "stable", label: "Stable", hint: "Tested releases." },
  { value: "nightly", label: "Nightly", hint: "New builds first, plus every stable release." },
];

export function UpdatesSection() {
  const { status, setChannel } = useUpdates();
  if (!status) return null;
  return (
    <section className="mt-10">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">Updates</h3>
      <div className="mb-4 flex gap-4 text-[0.9375rem]">
        <span className="w-28 flex-none text-muted-foreground">Version</span>
        <span className="min-w-0 truncate">{status.version}</span>
      </div>
      <RadioGroup
        value={status.channel}
        onValueChange={(value) => {
          if (value === "stable" || value === "nightly") setChannel(value);
        }}
        className="mb-2"
      >
        {CHANNELS.map((channel) => (
          <label key={channel.value} className="flex gap-3 py-2 text-[0.9375rem]">
            <Radio.Root
              value={channel.value}
              className="mt-1 size-4 flex-none rounded-full shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring data-checked:shadow-[inset_0_0_0_5px_#fff]"
            />
            <span>
              {channel.label}
              <span className="block text-[0.8125rem] text-muted-foreground">{channel.hint}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {status.aheadOf && (
        <p className="mb-2 text-[0.8125rem] text-muted-foreground">
          You're on a nightly newer than Stable {status.aheadOf}. You'll move to Stable with its
          next release after this build.
        </p>
      )}
      <UpdateState status={status} />
      <FreshStartState status={status} />
    </section>
  );
}

function UpdateState({ status }: { status: UpdateStatus }) {
  const { run, cancel } = useUpdates();
  const { update } = status;
  switch (update.kind) {
    case "idle":
    case "current":
    case "checking":
      return (
        <Row note={update.kind === "current" ? "Up to date." : null}>
          <Button disabled={update.kind === "checking"} onClick={() => run("updates.check")}>
            {update.kind === "checking" ? "Checking…" : "Check for updates"}
          </Button>
        </Row>
      );
    case "available":
      return (
        <Row note={`Version ${update.version} is available.`}>
          <Button variant="primary" onClick={() => run("updates.download")}>
            Update
          </Button>
        </Row>
      );
    case "downloading":
      return (
        <Progress label={`Downloading ${update.version}`} percent={update.percent}>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </Progress>
      );
    case "ready":
      return (
        <Row note={`Version ${update.version} is ready.`}>
          <Button
            variant="primary"
            onClick={() => useUi.setState({ updateDialog: "restart", settingsOpen: false })}
          >
            Restart to update
          </Button>
        </Row>
      );
    case "failed":
      return (
        <Row
          note={`${update.step === "check" ? "Couldn't check for updates." : "The download stopped."} ${update.detail}`}
          error
        >
          <Button
            onClick={() => run(update.step === "check" ? "updates.check" : "updates.download")}
          >
            Try again
          </Button>
        </Row>
      );
  }
}

/** The way back to Stable with this device's data erased; offered on nightly builds. */
function FreshStartState({ status }: { status: UpdateStatus }) {
  const { run, cancel } = useUpdates();
  const { fresh } = status;
  const installed = parseVersion(status.version);
  switch (fresh.kind) {
    case "idle":
      // Offered on nightly builds, while no update occupies the one download.
      if (!installed || channelOf(installed) !== "nightly") return null;
      if (status.update.kind === "downloading" || status.update.kind === "ready") return null;
      return (
        <div className="mt-3">
          <Button
            variant="ghost"
            onClick={() => useUi.setState({ updateDialog: "fresh", settingsOpen: false })}
          >
            Start fresh on Stable…
          </Button>
        </div>
      );
    case "downloading":
      return (
        <Progress label={`Downloading Stable ${fresh.version}`} percent={fresh.percent}>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </Progress>
      );
    case "ready":
      return (
        <Row note={`Stable ${fresh.version} is ready.`}>
          <Button
            variant="destructive"
            onClick={() => useUi.setState({ updateDialog: "erase", settingsOpen: false })}
          >
            Erase and install…
          </Button>
        </Row>
      );
    case "failed":
      return (
        <Row note={`Couldn't prepare Stable. ${fresh.detail}`} error>
          <Button onClick={() => run("updates.prepareFresh")}>Try again</Button>
        </Row>
      );
    case "not-installed":
      return (
        <Row
          note={`Stable ${fresh.version} wasn't installed. This device's data was erased as you asked.`}
        >
          <Button onClick={() => run("updates.prepareFresh")}>Try again</Button>
        </Row>
      );
  }
}

function Row({
  note,
  error = false,
  children,
}: {
  note: string | null;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mt-3">
      {note && (
        <p className={error ? "mb-3 text-sm text-destructive" : "mb-3 text-[0.9375rem]"}>{note}</p>
      )}
      <div className="flex flex-wrap gap-3">{children}</div>
    </div>
  );
}

function Progress({
  label,
  percent,
  children,
}: {
  label: string;
  percent: number;
  children: ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="h-1 overflow-hidden rounded-full bg-white/12">
        <div className="h-full bg-white" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 mb-3 text-[0.8125rem] text-muted-foreground">
        {label} · {percent} %
      </div>
      {children}
    </div>
  );
}
