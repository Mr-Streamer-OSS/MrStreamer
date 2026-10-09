// Sending playback to a TV: Live TV uses More > Play on; titles keep the output button.
// The picture area says where playback is while a receiver plays.
//
// Where the app finds receivers itself, as with Google Cast, the button opens its own list: This
// computer, the receivers found, and what is going on. Where only the system knows them, as with
// AirPlay on macOS, it opens the system's list at More or the title's output button.
// O opens either. Choosing changes nothing by itself: what plays goes on here until the receiver
// answers, and This computer cancels. The system's list belongs to the view it was asked from,
// and goes when that view closes (see `outputs.pick`).
import { Airplay, Cast, Monitor } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OutputFailure, Receiver } from "@mrstreamer/contracts/output";
import { miniPlayer } from "../../app/mini-player.ts";
import { isMac } from "../../app/platform.ts";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { outputs, receiverName, useOutput, where } from "../../player/output.ts";
import { player } from "../../player/player.ts";
import { titlePlayer } from "../../player/title-player.ts";
import { CloseMessage, useClosed } from "./CloseMessage.tsx";
import { Choice, Menu, MenuNote } from "./TrackMenus.tsx";

/** How long the note that a connect reached no receiver stays. */
const REFUSED_MS = 8000;
/** How long a receiver that stopped answering stays in the list, marked as gone. */
const GONE_MS = 2000;
/** After this long without a receiver, the list says none was found. */
const NONE_FOUND_MS = 6000;

/** Back to this computer: what a receiver plays goes on here, from where it was. */
export function playHere(): void {
  if (titlePlayer.onReceiver()) titlePlayer.playHere();
  else if (player.onReceiver()) player.playHere();
  else void outputs.local();
}

/**
 * O: opens the chooser, over the full window's controls. The mini player has none, so the window
 * goes back first, and the chooser opens once it has, full screen again where it was. An O the
 * viewer overtook opens nothing: with the mini player asked for again, or the view closed, no
 * controls are left to open over. `view` ends with the view that took the O, so one that opened
 * in its place meanwhile, or under another account, gets no chooser it never asked for. Where the
 * app lists receivers itself, `showList` opens that list; where only the system knows them, its
 * list opens at Live TV's More button or the title's output button.
 */
export async function openChooser(showList: () => void, view: AbortSignal): Promise<void> {
  const { account } = useUi.getState();
  if (!(await miniPlayer.leave())) return;
  if (view.aborted || account !== useUi.getState().account) return;
  const { offers } = outputs.status();
  if (offers.length === 0) return;
  if (offers.includes("cast")) return showList();
  outputs.pick();
}

/** Seconds since `since`, counted once a second; null while there is nothing to count. */
function useElapsed(since: number | null): number | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : Math.max(0, Math.floor((now - since) / 1000));
}

/** The icon of how a receiver is reached. */
function ReceiverIcon({ kind, className }: { kind: Receiver["kind"]; className?: string }) {
  return kind === "airplay" ? <Airplay className={className} /> : <Cast className={className} />;
}

/**
 * The title's output button, between the volume and the mini player. `open` and `onOpenChange` are the
 * app's own list, one of the menus over the controls; the system's list has no state here.
 */
export function OutputButton({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const offers = useOutput((state) => state.status.offers);
  const output = useOutput((state) => state.status.output);
  // The app's own list looks for receivers while it shows.
  useEffect(() => {
    outputs.list(open);
    return () => outputs.list(false);
  }, [open]);
  if (offers.length === 0) return null;
  const active = output.kind === "receiver" || output.kind === "lost";
  const listed = offers.includes("cast");
  const kind = listed ? "cast" : "airplay";
  const label = active ? `Playing ${where(output.receiver)}` : listed ? "Play on a TV" : "AirPlay";
  if (!listed) {
    // The system's list is the only chooser: a press opens it, and ends a connect under way.
    // It opens at this element (see `outputs.pick`).
    return (
      <span data-output="">
        <Tooltip label={label}>
          <Button
            variant={active ? "primary" : "media"}
            size="icon"
            aria-label={label}
            aria-pressed={active}
            onClick={() => (output.kind === "connecting" ? void outputs.local() : outputs.choose())}
          >
            <ReceiverIcon kind={kind} />
          </Button>
        </Tooltip>
      </span>
    );
  }
  return (
    <span data-output="">
      <Menu
        label={label}
        on={active}
        open={open}
        onOpenChange={onOpenChange}
        trigger={<ReceiverIcon kind={kind} />}
      >
        <Receivers
          onDone={() => onOpenChange(false)}
          onSystemList={() => {
            onOpenChange(false);
            outputs.pick();
          }}
        />
      </Menu>
    </span>
  );
}

/** The app's own list: This computer, the receivers found, and what is going on. */
export function Receivers({
  onDone,
  onSystemList,
}: {
  onDone: () => void;
  onSystemList: () => void;
}) {
  const status = useOutput((state) => state.status);
  const connectingSince = useOutput((state) => state.connectingSince);
  const refused = useOutput((state) => state.refused);
  const { output } = status;
  const connecting = useElapsed(connectingSince);
  // The list has done its work once the receiver answers.
  const was = useRef(output.kind);
  useEffect(() => {
    if (was.current === "connecting" && output.kind === "receiver") onDone();
    was.current = output.kind;
  }, [output.kind, onDone]);
  // Counted from when the list opened.
  const opened = useRef(Date.now()).current;
  const looking = useElapsed(opened) ?? 0;
  const gone = useGone(status.receivers);
  const current = output.kind === "receiver" || output.kind === "lost" ? output.receiver : null;
  const target = output.kind === "connecting" ? output.receiver : null;
  // The connected one stays listed while the browse hasn't heard from it lately.
  const receivers = [
    ...status.receivers.filter((each) => each.kind === "cast"),
    ...(current &&
    current.kind === "cast" &&
    !status.receivers.some((each) => each.id === current.id)
      ? [current]
      : []),
  ];
  const nothing = receivers.length === 0 && gone.length === 0;
  return (
    <>
      <Choice
        chosen={output.kind === "local" || output.kind === "connecting"}
        onChoose={() => {
          // Ends a connect under way, or brings back what a receiver plays.
          if (output.kind !== "local") playHere();
          onDone();
        }}
      >
        This computer
      </Choice>
      {receivers.map((receiver) => (
        <Choice
          key={receiver.id}
          chosen={current?.id === receiver.id}
          note={
            target?.id === receiver.id
              ? `Connecting · ${connecting ?? 0} s`
              : refused?.receiver.id === receiver.id
                ? "Didn't connect"
                : null
          }
          onChoose={() => {
            if (current?.id === receiver.id && output.kind === "receiver") return onDone();
            outputs.connect(receiver.id);
          }}
        >
          {receiverName(receiver)}
        </Choice>
      ))}
      {gone.map((receiver) => (
        <Choice key={receiver.id} chosen={false} disabled note="Gone" onChoose={() => {}}>
          {receiverName(receiver)}
        </Choice>
      ))}
      {status.offers.includes("airplay") && (
        <Choice chosen={current?.kind === "airplay"} onChoose={onSystemList}>
          AirPlay
        </Choice>
      )}
      <MenuNote>
        {output.kind === "connecting"
          ? "Plays here until the TV answers. This computer cancels."
          : !nothing
            ? status.offers.includes("airplay") && "AirPlay opens Apple's list at the controls."
            : !status.offers.includes("cast")
              ? "AirPlay opens Apple's list at the controls."
              : looking < NONE_FOUND_MS / 1000
                ? `Looking for Cast devices · ${looking} s`
                : "No Cast devices found on this network."}
      </MenuNote>
    </>
  );
}

/** The receivers that stopped answering a moment ago: listed a little longer, marked as gone. */
function useGone(receivers: readonly Receiver[]): readonly Receiver[] {
  const before = useRef(receivers);
  const [gone, setGone] = useState<readonly Receiver[]>([]);
  useEffect(() => {
    const left = before.current.filter(
      (was) => was.kind === "cast" && !receivers.some((each) => each.id === was.id),
    );
    before.current = receivers;
    if (left.length === 0) return;
    setGone((known) => [
      ...known.filter((each) => !left.some((one) => one.id === each.id)),
      ...left,
    ]);
    const timer = setTimeout(
      () => setGone((known) => known.filter((each) => !left.some((one) => one.id === each.id))),
      GONE_MS,
    );
    return () => clearTimeout(timer);
  }, [receivers]);
  return gone.filter((each) => !receivers.some((one) => one.id === each.id));
}

/**
 * What a connect has to say, where a pressed key's word shows. While it waits for the viewer in
 * the system's list: how long it has, and where a code the TV may show goes; the system owns that
 * prompt, so the app can't tell whether one was asked for. And for a few seconds after a connect
 * that reached no receiver: why, while what played here plays on, unless the viewer closes it.
 */
export function ConnectingNote() {
  const output = useOutput((state) => state.status.output);
  const since = useOutput((state) => state.connectingSince);
  const refused = useOutput((state) => state.refused);
  const seconds = useElapsed(since);
  const closed = useClosed(refused);
  const [, expire] = useState(0);
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => expire((count) => count + 1), REFUSED_MS);
    return () => clearTimeout(timer);
  }, [refused]);
  const waiting = output.kind === "connecting" && output.protocol === "airplay";
  const failed =
    !waiting &&
    output.kind === "local" &&
    refused &&
    !closed &&
    Date.now() - refused.at < REFUSED_MS
      ? receiverProblem(refused.failure, false, refused.receiver, null)
      : null;
  if (!waiting && !failed) return null;
  return (
    <div
      className={cn(
        "pointer-events-none fixed top-12 right-12 z-40 max-w-[22rem] rounded-3xl bg-black/80 px-6 py-4 ring-1 ring-white/10",
        failed && "pr-14",
      )}
    >
      <div role="status">
        <div className="text-xl font-semibold tracking-tight tabular-nums">
          {failed ? failed.title : `Connecting over AirPlay · ${seconds ?? 0} s`}
        </div>
        <div className="mt-1 text-[0.8125rem] leading-snug text-muted-foreground">
          {failed ? failed.body : "If your TV shows a code, enter it in the AirPlay window."}
        </div>
      </div>
      {failed && refused && <CloseMessage failure={refused} className="top-3 right-3" />}
    </div>
  );
}

/** "Playing on Living Room TV": the receiver's state, where the picture would be. */
export function ReceiverLine({ receiver, children }: { receiver: Receiver; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-lg font-semibold">
      <ReceiverIcon kind={receiver.kind} className="size-5 flex-none" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Play here, the way back to this computer that every receiver state offers. `onPlay` replaces
 * what it does, for where the player's view has to open first.
 */
export function PlayHere({
  size,
  onPlay,
}: {
  size?: "default" | "lg" | "sm";
  onPlay?: () => void;
}) {
  return (
    <Button variant="secondary" size={size ?? "default"} onClick={onPlay ?? playHere}>
      <Monitor />
      Play here
    </Button>
  );
}

/**
 * What a receiver that doesn't play says: a title, a body, and whether trying again can help.
 * `stopped` is what stopped and where, "Canyon Hours stopped at 12:04.", for a lost connection.
 */
export function receiverProblem(
  failure: OutputFailure,
  lost: boolean,
  receiver: Pick<Receiver, "kind" | "name"> | null,
  stopped: string | null,
): { readonly title: string; readonly body: string; readonly retry: boolean } {
  const name = receiverName(receiver);
  switch (failure.kind) {
    case "unreachable":
      return lost
        ? {
            title: `${name} connection lost`,
            body: stopped ?? "Check that it is on and on this network.",
            retry: true,
          }
        : {
            title: `${name} didn't answer`,
            body: "Check that it is on and on this network.",
            retry: true,
          };
    case "not-fetched":
      return {
        title: `${name} got no stream`,
        body: isMac
          ? "It never fetched the stream from this computer. Check that both are on the same network."
          : "It never fetched the stream from this computer. Windows Firewall usually causes this. In Windows Security, open Allow an app through firewall and tick Private for Mr. Streamer.",
        retry: true,
      };
    case "media":
      return {
        title: `${name} can't play this`,
        body: "It took the stream and could not play it.",
        retry: false,
      };
    case "no-network":
      return {
        title: "No local network",
        body: "This computer is offline or on a VPN only, so a TV cannot reach it.",
        retry: false,
      };
    case "unavailable":
      return receiver?.kind === "cast"
        ? { title: `${name} isn't available`, body: failure.detail, retry: true }
        : {
            title: "AirPlay isn't available",
            body: "The part of Mr. Streamer that speaks AirPlay did not start.",
            retry: false,
          };
    case "stream":
      // The provider's own failures have their messages where they always had them.
      return {
        title: `${name} got no stream`,
        body: "The provider did not deliver it.",
        retry: true,
      };
  }
}
