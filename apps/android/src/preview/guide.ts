import type { createGuide, GuideChannel, DayPage } from "../guide/guide.ts";
import { channels, programmes } from "./catalogue.ts";
import { preview, exampleId } from "./session.ts";

/** Select local display facts only. Native guide ownership and persistence stay with the real service. */
export function presentationGuide(
  real: ReturnType<typeof createGuide>,
): ReturnType<typeof createGuide> {
  const rows: readonly GuideChannel[] = channels.map((r, i) => ({
    id: String(i + 1),
    key: r.key,
    title: r.title,
  }));

  const page = (key: string, from: number): DayPage => ({
    programmes: programmes(from).map((p) => ({ ...p, detail: `${key}|${p.start}` })),
    cursor: null,
  });

  return {
    ...real,
    status: (id) =>
      preview.get()
        ? {
            availability: "available",
            activity: "idle",
            fetchedAt: null,
            stale: false,
            error: null,
          }
        : real.status(id),
    channels: () => (preview.get() ? new Map([[exampleId, rows]]) : real.channels()),
    channel: (key) =>
      preview.get() ? (rows.find((r) => r.key === key) ?? null) : real.channel(key),
    listings: async (...args) => {
      if (!preview.get()) return real.listings(...args);
      const [now, next] = programmes(Date.now());

      return new Map(
        args[0]
          .filter((key) => rows.some((r) => r.key === key))
          .map((key) => [key, { now: now ?? null, next: next ?? null }]),
      );
    },
    schedule: async (...args) =>
      preview.get() ? page(args[0], args[1].from) : real.schedule(...args),
    programme: async (...args) => {
      if (!preview.get()) return real.programme(...args);
      const start = Number(args[0].split("|").at(-1));

      return Number.isFinite(start) ? (programmes(start)[0] ?? null) : null;
    },
    programmeAt: async (...args) =>
      preview.get() ? (programmes(args[1])[0] ?? null) : real.programmeAt(...args),
    search: async (...args) =>
      preview.get()
        ? {
            found: args[1].flatMap((key) =>
              page(key, Date.now())
                .programmes.filter((p) => p.title.toLowerCase().includes(args[0].toLowerCase()))
                .map((programme) => ({ key, programme })),
            ),
            unsearched: false,
          }
        : real.search(...args),
  };
}
