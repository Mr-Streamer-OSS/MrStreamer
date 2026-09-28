import type { Category, LiveChannel } from "../../../shared/library.ts";
import type { StreamInfo } from "../player/engine.ts";

/** "818 · Vlaanderen": the channel number and its first category. */
export function channelLine(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): string {
  const category = channel.categoryIds.map((id) => categories.get(id)).find(Boolean);
  return [channel.number, category?.title].filter((part) => part != null).join(" · ");
}

/** "1080p · 50 fps · Stereo" from whatever the engine knows. */
export function techLine(info: StreamInfo | null): string {
  if (!info) return "";
  const parts: string[] = [];
  if (info.height) parts.push(`${info.height}p`);
  if (info.fps) parts.push(`${Math.round(info.fps)} fps`);
  if (info.audioChannels) {
    parts.push(
      info.audioChannels === 1
        ? "Mono"
        : info.audioChannels === 2
          ? "Stereo"
          : `${info.audioChannels} ch`,
    );
  }
  return parts.join(" · ");
}
