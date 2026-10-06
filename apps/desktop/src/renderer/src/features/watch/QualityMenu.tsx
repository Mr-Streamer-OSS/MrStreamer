// The quality button beside Sound and CC, on a channel with several streams: it says what plays,
// and Q opens it. Automatic starts at the preferred quality and passes a stream that doesn't
// start; a quality picked here is remembered for the channel and never passed. Each row says what
// the channel's last try got from its stream, where it got anything.
import type { ChannelVariant, LiveChannel } from "@mrstreamer/contracts/library";
import { Button } from "../../components/ui/button.tsx";
import { qualityChoices, qualityName, shortQuality } from "../../lib/quality.ts";
import { Choice, Menu } from "./TrackMenus.tsx";

export function QualityMenu({
  channel,
  chosen,
  automatic,
  playing,
  height,
  notes,
  open,
  onOpenChange,
  onChoose,
}: {
  channel: LiveChannel;
  /** The stream chosen for the channel, or null for Automatic. */
  chosen: ChannelVariant | null;
  /** The stream Automatic plays, or would start with. */
  automatic: ChannelVariant | undefined;
  /** The stream playing, once one is. */
  playing: ChannelVariant | undefined;
  /** The picture's height as decoded, once known. */
  height: number | null;
  /** What the channel's last try says of its streams, by stream id: "No stream · 404". */
  notes: ReadonlyMap<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (variantId: string | null) => void;
}) {
  const choices = qualityChoices(channel);
  const shown = playing ?? chosen ?? automatic;
  const pick = (variantId: string | null) => {
    onChoose(variantId);
    onOpenChange(false);
  };
  return (
    <Menu
      label="Quality"
      open={open}
      onOpenChange={onOpenChange}
      trigger={shortQuality(shown) ?? (height ? `${height}p` : "Quality")}
      text
    >
      <Choice chosen={chosen === null} onChoose={() => pick(null)}>
        Automatic<span className="text-muted-foreground"> · {qualityName(automatic)}</span>
      </Choice>
      {choices.map(({ variant, name }) => (
        <Choice
          key={variant.id}
          chosen={variant.id === chosen?.id}
          note={notes.get(variant.id) ?? null}
          onChoose={() => pick(variant.id)}
        >
          {name}
        </Choice>
      ))}
      <div className="mx-2 my-1.5 h-px bg-white/10" />
      {chosen ? (
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground/85">
            {choices.find(({ variant }) => variant.id === chosen.id)?.name} for {channel.title}
          </span>
          <Button data-item variant="secondary" size="sm" onClick={() => pick(null)}>
            Use Automatic
          </Button>
        </div>
      ) : (
        playing && (
          <div className="px-2 py-1 text-[0.8125rem] text-muted-foreground">
            Playing{" "}
            {[qualityName(playing), height ? `${height}p` : null].filter(Boolean).join(" · ")}
          </div>
        )
      )}
    </Menu>
  );
}
