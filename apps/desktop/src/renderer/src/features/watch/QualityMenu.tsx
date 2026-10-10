// A channel with several streams offers quality choices in Live TV's More menu; Q opens its page.
// Automatic starts at the preferred quality and passes a stream that doesn't
// start; a quality picked here is remembered for the channel and never passed. Each row says what
// the channel's last try got from its stream, where it got anything.
import type { ChannelVariant, LiveChannel } from "@mrstreamer/contracts/library";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { qualityChoices, qualityName } from "../../lib/quality.ts";
import { Choice } from "./TrackMenus.tsx";

interface QualityProps {
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
  onDone: () => void;
  onChoose: (variantId: string | null) => void;
}

/** Quality choices shown as a page anchored to Live TV's More button. */
export function QualityChoices({
  channel,
  chosen,
  automatic,
  playing,
  height,
  notes,
  onChoose,
  onDone,
}: QualityProps) {
  const choices = qualityChoices(channel);
  const pick = (variantId: string | null) => {
    onChoose(variantId);
    onDone();
  };
  return (
    <>
      <Choice chosen={chosen === null} onChoose={() => pick(null)}>
        {t("Automatic")}
        <span className="text-muted-foreground"> · {qualityName(automatic)}</span>
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
            {t("{quality} for {name}", {
              quality: choices.find(({ variant }) => variant.id === chosen.id)?.name ?? "",
              name: channel.title,
            })}
          </span>
          <Button data-item variant="secondary" size="sm" onClick={() => pick(null)}>
            {t("Use Automatic")}
          </Button>
        </div>
      ) : (
        playing && (
          <div className="px-2 py-1 text-[0.8125rem] text-muted-foreground">
            {t("Playing {where}", {
              where: [qualityName(playing), height ? `${height}p` : null]
                .filter(Boolean)
                .join(" · "),
            })}
          </div>
        )
      )}
    </>
  );
}
