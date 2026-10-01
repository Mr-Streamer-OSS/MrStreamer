// Settings > Movies & series: the language titles show and play in, and TMDB, where genres,
// popularity and streaming services come from. The app has its own key; a viewer's own comes
// first, for when TMDB stops accepting the app's.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { DEFAULT_TITLE_LANGUAGE, TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";

export function TitlesSection() {
  const client = useQueryClient();
  const preferences = useQuery(queries.preferences());
  const status = useQuery(queries.onDemandStatus());
  const [key, setKey] = useState("");
  const update = useMutation({
    mutationFn: (patch: Partial<Preferences>) => call("preferences.update", patch),
    onSuccess: async (saved) => {
      client.setQueryData(queries.preferences().queryKey, saved);
      // Lists show other versions in another language; a new key fetches again.
      await client.invalidateQueries({ queryKey: ["ondemand"] });
    },
  });
  const language = preferences.data?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE;
  const ownKey = Boolean(preferences.data?.tmdbKey);
  const metadata = status.data?.metadata;
  const progress = !metadata
    ? "No key, so no genres or streaming services."
    : metadata.refused
      ? "TMDB refused the key."
      : metadata.known < metadata.wanted
        ? `Details for ${metadata.known.toLocaleString()} of ${metadata.wanted.toLocaleString()} titles so far.`
        : `Details for ${metadata.known.toLocaleString()} titles.`;

  return (
    <section className="space-y-10 text-[0.9375rem]">
      <div>
        <label htmlFor="title-language" className="mb-2 block font-medium">
          Language
        </label>
        <select
          id="title-language"
          value={language}
          onChange={(event) => update.mutate({ titleLanguage: event.target.value })}
          className="h-11 w-64 rounded-xl bg-white/6 px-3 ring-1 ring-input outline-none focus:ring-2 focus:ring-ring"
        >
          {TITLE_LANGUAGES.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
        <p className="mt-2 text-muted-foreground">
          Which version of a film plays, the sound to start with, and what the rows show.
        </p>
      </div>

      <div>
        <div className="mb-2 font-medium">TMDB</div>
        <p className="mb-3 text-muted-foreground">
          {ownKey ? "Your key. " : ""}
          {progress}
        </p>
        <form
          className="flex gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) update.mutate({ tmdbKey: key.trim() });
            setKey("");
          }}
        >
          <Input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="Your own key or read access token"
            aria-label="Your own TMDB key"
            className="h-11 flex-1"
          />
          <Button type="submit" variant="secondary" disabled={!key.trim()}>
            Use
          </Button>
        </form>
        {ownKey && (
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => update.mutate({ tmdbKey: "" })}
            className="mt-3 text-muted-foreground underline underline-offset-4 hover:text-white"
          >
            Use the app's key again
          </button>
        )}
      </div>
    </section>
  );
}
