import { afterEach, expect, it } from "vitest";
import { setLanguage } from "@mrstreamer/core/i18n";
import { playlistReader } from "../src/connect/playlist.ts";

afterEach(() => setLanguage({ locale: "en-US", formats: "en-US" }));

it.each([
  [
    "refused",
    "Je provider heeft deze afspeellijstlink geweigerd. Controleer de link of vraag je provider om een nieuwe.",
  ],
  [
    "authenticate",
    "Dit adres is geen afspeellijst. Een serveradres heeft een gebruikersnaam en wachtwoord nodig.",
  ],
  ["not-playlist", "Het adres reageerde, maar niet met een afspeellijst."],
  ["size", "Deze afspeellijst is groter dan 64 MB, meer dan de telefoon kan lezen."],
  ["entries", "Deze afspeellijst bevat meer dan 100.000 items, meer dan de telefoon kan lezen."],
] as const)("reports the Dutch %s playlist failure through its reader", async (mode, detail) => {
  setLanguage({ locale: "nl-NL", formats: "nl-NL" });

  const reader = playlistReader("https://fixture.example.invalid/list.m3u", {
    userAgent: "test",
    fetch: async () =>
      new Response(
        mode === "entries"
          ? "#EXTM3U\n" +
              "#EXTINF:-1,Fixture\nhttps://fixture.example.invalid/live\n".repeat(100_001)
          : "not a playlist",
        {
          status: mode === "refused" ? 403 : 200,
          headers: mode === "size" ? { "content-length": String(64 * 1024 * 1024 + 1) } : {},
        },
      ),
  });

  await expect(
    mode === "authenticate" ? reader.authenticate() : reader.liveCatalogue(),
  ).rejects.toMatchObject({ error: { detail } });
});
