import { Volume2, VolumeX } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { Slider } from "../../components/ui/slider.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { useOutput } from "../../player/output.ts";
import { player, usePlayer } from "../../player/player.ts";

/**
 * Mute toggle plus a volume slider: this computer's, or the receiver's while one has playback. A
 * receiver whose volume can't be set from here says whose remote sets it.
 */
export function VolumeControl() {
  const local = usePlayer((state) => state.volume);
  const localMuted = usePlayer((state) => state.muted);
  const output = useOutput((state) => state.status.output);
  const remote = output.kind === "receiver" || output.kind === "lost";
  const receiver = output.kind === "receiver" ? output.volume : null;
  if (remote && !receiver) {
    return (
      <span className="px-1 text-[0.8125rem] text-muted-foreground">TV remote sets volume</span>
    );
  }
  const volume = receiver?.level ?? local;
  const muted = receiver?.muted ?? localMuted;
  return (
    <div className="flex items-center gap-3">
      <Tooltip label={muted ? "Unmute" : "Mute"}>
        <Button
          variant="media"
          size="icon"
          aria-label={muted ? "Unmute" : "Mute"}
          onClick={() => player.toggleMute()}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </Button>
      </Tooltip>
      <Slider
        label="Volume"
        value={muted ? 0 : volume}
        onValueChange={(value) => player.setVolume(value)}
      />
    </div>
  );
}
