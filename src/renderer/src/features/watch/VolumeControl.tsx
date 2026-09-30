import { Volume2, VolumeX } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { Slider } from "../../components/ui/slider.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { player, usePlayer } from "../../player/player.ts";

/** Mute toggle plus a volume slider. */
export function VolumeControl() {
  const volume = usePlayer((state) => state.volume);
  const muted = usePlayer((state) => state.muted);
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
