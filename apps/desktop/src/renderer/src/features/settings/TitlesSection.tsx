// Settings > Movies & series: the language titles show and play in, whether titles for adults
// show, and TMDB, where genres, popularity and streaming services come from. The app has its
// own key; a viewer's own comes first, for when TMDB stops accepting the app's.
import { Checkbox } from "@base-ui/react/checkbox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { DEFAULT_TITLE_LANGUAGE, TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
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
      // Lists change with the language and with titles for adults; a new key fetches again.
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

      <label className="flex items-center gap-3">
        <Checkbox.Root
          checked={preferences.data?.adultTitles ?? false}
          onCheckedChange={(checked) => update.mutate({ adultTitles: checked })}
          className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-white data-checked:shadow-none"
        >
          <Checkbox.Indicator>
            <Check className="size-3 text-black" strokeWidth={3} />
          </Checkbox.Indicator>
        </Checkbox.Root>
        <span>
          Titles for adults{" "}
          <span className="text-muted-foreground">
            · In their own tab, never on Home or in search
          </span>
        </span>
      </label>

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
            if (key.trim()) update.mutate({ tmdbKey: key.trim() }, { onSuccess: () => setKey("") });
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
        {update.error && (
          <p className="mt-3 text-destructive">{describeError(appError(update.error))}</p>
        )}
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
