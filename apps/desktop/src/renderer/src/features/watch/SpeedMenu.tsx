// The title's Speed button, beside Sound and CC: a movie or episode slower or faster. Live channels
// play at their own speed and have no such button. The player keeps the speed, so it holds after a
// seek or another track.
import { Gauge } from "lucide-react";
import { formatNumber, t } from "@mrstreamer/core/i18n";
import { SPEEDS, titlePlayer, type Speed } from "../../player/title-player.ts";
import { flash } from "./Flash.tsx";
import { Choice, Menu, MenuNote } from "./TrackMenus.tsx";

/** < and >: a movie or episode one speed slower or faster. */
export function stepSpeed(direction: -1 | 1): void {
  flash(t("Speed {speed}", { speed: speedLabel(titlePlayer.stepSpeed(direction)) }));
}

export function SpeedMenu({
  speed,
  hereOnly = false,
  open,
  onSpeed,
  onOpenChange,
}: {
  speed: Speed;
  /** A receiver on the network plays: the speed is this computer's, listed and not set. */
  hereOnly?: boolean;
  open: boolean;
  onSpeed: (speed: Speed) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Menu label={t("Speed")} open={open} onOpenChange={onOpenChange} trigger={<Gauge />}>
      {hereOnly ? (
        <>
          <Choice chosen={false} disabled note={speedLabel(1)} onChoose={() => {}}>
            {t("Speed")}
          </Choice>
          <MenuNote>{t("Speed applies on this computer only.")}</MenuNote>
        </>
      ) : (
        SPEEDS.map((each) => (
          <Choice
            key={each}
            chosen={each === speed}
            onChoose={() => {
              onSpeed(each);
              onOpenChange(false);
            }}
          >
            {speedLabel(each)}
          </Choice>
        ))
      )}
    </Menu>
  );
}

function speedLabel(speed: number): string {
  return `${formatNumber(speed)}×`;
}
