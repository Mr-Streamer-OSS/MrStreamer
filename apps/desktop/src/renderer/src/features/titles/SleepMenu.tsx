// The title's sleep timer button, after Speed (Paper A8): a menu of minutes and the end of what
// plays, which pauses it there. While a timer is set the button is on and names when it pauses, a
// time on the clock or End. The title player owns the timer (see title-player.ts): it carries on
// through the next episode and a pause, and ends when it fires, is turned off here or the player
// closes.
import { Moon } from "lucide-react";
import { t } from "@mrstreamer/core/i18n";
import { clockTime } from "../../lib/format.ts";
import { useOutput, where } from "../../player/output.ts";
import { titlePlayer, useTitlePlayer, type SleepChoice } from "../../player/title-player.ts";
import { Choice, Menu, MenuNote } from "../watch/TrackMenus.tsx";

/** The minutes offered. One minute lets a viewer, or a check of the built app, see it fire. */
const SLEEP_MINUTES = [1, 15, 30, 45, 60, 90] as const;

export function SleepMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sleep = useTitlePlayer((state) => state.sleep);
  const episode = useTitlePlayer((state) => state.now?.title.kind === "episode");
  // A receiver plays: the timer pauses it there.
  const remote = useTitlePlayer((state) => state.shows !== null);
  const output = useOutput((state) => state.status.output);
  const receiver = remote && output.kind === "receiver" ? output.receiver : null;
  const at = sleep?.kind === "after" ? clockTime(sleep.at, Date.now()) : null;

  const choose = (choice: SleepChoice | null) => {
    titlePlayer.setSleep(choice);
    onOpenChange(false);
  };

  return (
    <Menu
      label={t("Sleep timer")}
      on={sleep !== null}
      text={sleep !== null}
      description={
        at ? t("Pauses at {time}", { time: at }) : sleep ? t("Pauses at the end") : undefined
      }
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <>
          <Moon />
          {sleep && <span className="tabular-nums">{at ?? t("End")}</span>}
        </>
      }
    >
      <Choice chosen={sleep === null} onChoose={() => choose(null)}>
        {t("Off")}
      </Choice>
      {SLEEP_MINUTES.map((minutes) => {
        const chosen = sleep?.kind === "after" && sleep.minutes === minutes;

        return (
          <Choice
            key={minutes}
            chosen={chosen}
            note={chosen && at ? t("Pauses at {time}", { time: at }) : null}
            onChoose={() => choose({ kind: "after", minutes })}
          >
            {t("{minutes} min", { minutes })}
          </Choice>
        );
      })}
      <Choice chosen={sleep?.kind === "end"} onChoose={() => choose({ kind: "end" })}>
        {episode ? t("End of this episode") : t("End of this title")}
      </Choice>
      <MenuNote>
        {receiver
          ? t("Pauses playback {where}. Downloads and recordings carry on.", {
              where: where(receiver),
            })
          : t("Pauses playback on this computer. Downloads and recordings carry on.")}
      </MenuNote>
    </Menu>
  );
}
