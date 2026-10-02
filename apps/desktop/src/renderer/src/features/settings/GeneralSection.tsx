// Settings > General: the content preferences, then Updates. Movies and series show in one
// language, play their sound in another, or in the language they were made in, and show
// subtitles in a third, only forced ones or none; picking a track in the player sets these too.
// TMDB is where names, genres, popularity and streaming services come from. The app has its own
// key; a viewer's own comes first, for when TMDB stops accepting the app's.
import { Checkbox } from "@base-ui/react/checkbox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { ORIGINAL_SOUND, type Preferences } from "@mrstreamer/contracts/preferences";
import { DEFAULT_TITLE_LANGUAGE, TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { UpdatesSection } from "../updates/UpdatesSection.tsx";
import { Row, Section, Select } from "./Rows.tsx";

/** The Subtitles choice for only the subtitles a file marks as forced: no language stored. */
const FORCED = "forced";

/** Changes that alter what the lists show, which are asked for again. */
const LIST_CHANGES = ["titleLanguage", "adultTitles", "tmdbKey"] as const;

export function GeneralSection() {
  const client = useQueryClient();
  // Read afresh each time Settings opens: the players save the languages picked in them without
  // going through this cache.
  const preferences = useQuery({ ...queries.preferences(), refetchOnMount: "always" });
  const update = useMutation({
    mutationFn: (patch: Partial<Preferences>) => call("preferences.update", patch),
    onSuccess: async (saved, patch) => {
      client.setQueryData(queries.preferences().queryKey, saved);
      if (LIST_CHANGES.some((key) => key in patch)) {
        await client.invalidateQueries({ queryKey: ["ondemand"] });
      }
    },
  });
  const titles = preferences.data?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE;
  const audio = preferences.data?.audioLanguage ?? titles;
  const subtitles = preferences.data?.subtitleLanguage ?? FORCED;

  return (
    <>
      <Section title="Movies and series">
        <Row label="Titles in">
          <Select
            label="Titles in"
            value={titles}
            options={languages(titles)}
            onChange={(titleLanguage) => update.mutate({ titleLanguage })}
          />
        </Row>
        <Row label="Audio in">
          <Select
            label="Audio in"
            value={audio}
            options={[{ value: ORIGINAL_SOUND, label: "Original language" }, ...languages(audio)]}
            onChange={(audioLanguage) => update.mutate({ audioLanguage })}
          />
        </Row>
        <Row label="Subtitles">
          <Select
            label="Subtitles"
            value={subtitles}
            options={[
              { value: "off", label: "Off" },
              { value: FORCED, label: "Only when forced" },
              ...languages(subtitles),
            ]}
            onChange={(value) =>
              update.mutate({ subtitleLanguage: value === FORCED ? null : value })
            }
          />
        </Row>
        <Row label="Titles for adults" note="in their own tab, never on Home or in search">
          <Checkbox.Root
            aria-label="Titles for adults"
            checked={preferences.data?.adultTitles ?? false}
            onCheckedChange={(checked) => update.mutate({ adultTitles: checked })}
            className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-white data-checked:shadow-none"
          >
            <Checkbox.Indicator>
              <Check className="size-3 text-black" strokeWidth={3} />
            </Checkbox.Indicator>
          </Checkbox.Root>
        </Row>
        <Tmdb
          ownKey={Boolean(preferences.data?.tmdbKey)}
          onKey={(tmdbKey, done) => update.mutate({ tmdbKey }, { onSuccess: done })}
        />
        {update.error && (
          <p className="mt-3 text-sm text-destructive">{describeError(appError(update.error))}</p>
        )}
      </Section>
      <UpdatesSection />
    </>
  );
}

/** The languages to pick from, with `current` added when it is another, as picked in a player. */
function languages(current: string): { value: string; label: string }[] {
  const listed: { value: string; label: string }[] = TITLE_LANGUAGES.map((language) => ({
    value: language.code,
    label: language.name,
  }));
  const other = current !== ORIGINAL_SOUND && current !== "off" && current !== FORCED;
  return other && !listed.some((option) => option.value === current)
    ? [...listed, { value: current, label: languageName(current) ?? current }]
    : listed;
}

/** How far TMDB got, and the viewer's own key: pasted in a field that opens on asking. */
function Tmdb({
  ownKey,
  onKey,
}: {
  ownKey: boolean;
  onKey: (key: string, done: () => void) => void;
}) {
  const status = useQuery(queries.onDemandStatus());
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const metadata = status.data?.metadata;
  const progress = !metadata
    ? "no key"
    : metadata.refused
      ? "refused the key"
      : metadata.known < metadata.wanted
        ? `${metadata.known.toLocaleString()} of ${metadata.wanted.toLocaleString()} titles`
        : `${metadata.known.toLocaleString()} titles`;
  return (
    <>
      <Row label="TMDB" note={ownKey ? `your key · ${progress}` : progress}>
        {ownKey && (
          <Button variant="ghost" size="sm" onClick={() => onKey("", () => {})}>
            Use the app's key
          </Button>
        )}
        {!editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Own key…
          </Button>
        )}
      </Row>
      {editing && (
        <form
          className="flex gap-3 border-b border-white/8 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!key.trim()) return;
            onKey(key.trim(), () => {
              setKey("");
              setEditing(false);
            });
          }}
        >
          <Input
            autoFocus
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="Your own key or read access token"
            aria-label="Your own TMDB key"
            className="h-9 flex-1"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!key.trim()}>
            Use
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      )}
    </>
  );
}
