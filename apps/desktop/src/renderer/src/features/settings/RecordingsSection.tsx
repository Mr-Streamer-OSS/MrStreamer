// Settings > Recordings: the folder new recordings go to, with how much they take and the room
// left, Change and Open; how much to keep free on its disk and the space recordings may take. A
// limit reached pauses a recording until there is room again; nothing is deleted to make it.
// Below, what closing the window, quitting, sleep and updates do while something records.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_KEEP_FREE, type RecordingLimits } from "@mrstreamer/contracts/recordings";
import { formatBytes, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { call } from "../../lib/ipc.ts";
import { changeStorage, formatLimit, useRecordingStorage } from "../recordings/recordings.ts";
import { Row, Section, Select } from "./Rows.tsx";
import { SaveFeedback } from "./SaveFeedback.tsx";

const GIB = 1024 ** 3;
const KEEP_FREE = [1, 5, 10, 20, 50].map((size) => size * GIB);
const SPACE = [50, 100, 250, 500, 1024].map((size) => size * GIB);
const NO_LIMIT = "none";

/** `sizes` as choices, with `current` among them when it was set to another. */
function sizeChoices(sizes: readonly number[], current: number) {
  return [...new Set([...sizes, current])]
    .toSorted((a, b) => a - b)
    .map((size) => ({ value: String(size), label: formatLimit(size) }));
}

export function RecordingsSection() {
  const client = useQueryClient();
  const storage = useRecordingStorage();
  const folder = useMutation({ mutationFn: () => changeStorage(client, "folder") });
  const opening = useMutation({ mutationFn: () => call("recordings.openFolder") });
  const limits = useMutation({
    mutationFn: (next: RecordingLimits) => changeStorage(client, next),
  });
  const saved = storage.data;
  const keepFree = saved?.keepFree ?? DEFAULT_KEEP_FREE;
  const space = saved?.space ?? null;
  const setLimits = (next: Partial<RecordingLimits>) => {
    if (!limits.isPending) limits.mutate({ keepFree, space, ...next });
  };
  return (
    <>
      <Section title={t("Storage")}>
        {storage.isError && (
          <SaveFeedback
            pending={storage.isFetching}
            error={storage.error}
            retry={() => void storage.refetch()}
          />
        )}
        <fieldset disabled={!saved} className="min-w-0">
          <Row
            id="recordings-folder"
            label={t("Folder")}
            wrap
            note={
              saved &&
              [
                saved.folder,
                t("{size} used", { size: formatBytes(saved.used) }),
                saved.free !== null && t("{size} free", { size: formatBytes(saved.free) }),
              ]
                .filter(Boolean)
                .join(" · ")
            }
          >
            <Button size="sm" disabled={folder.isPending} onClick={() => folder.mutate()}>
              {t("Change")}
            </Button>
            <Button size="sm" onClick={() => opening.mutate()}>
              {t("Open")}
            </Button>
          </Row>
          <SaveFeedback pending={false} error={folder.error} retry={() => folder.mutate()} />
          <SaveFeedback pending={false} error={opening.error} retry={() => opening.mutate()} />
          <Row
            id="recordings-keep-free"
            label={t("Keep free on disk")}
            wrap
            note={t("Below this, recording pauses and the rest is recorded once space is free.")}
          >
            <Select
              label={t("Keep free on disk")}
              busy={limits.isPending}
              value={String(keepFree)}
              options={sizeChoices(KEEP_FREE, keepFree)}
              onChange={(value) => setLimits({ keepFree: Number(value) })}
            />
          </Row>
          <Row
            id="recordings-space"
            label={t("Space for recordings")}
            wrap
            note={t(
              "At the limit, recording pauses the same way. Nothing is deleted to make room.",
            )}
          >
            <Select
              label={t("Space for recordings")}
              busy={limits.isPending}
              value={space === null ? NO_LIMIT : String(space)}
              options={[
                { value: NO_LIMIT, label: t("No limit") },
                ...sizeChoices(SPACE, space ?? SPACE[0]!),
              ]}
              onChange={(value) => setLimits({ space: value === NO_LIMIT ? null : Number(value) })}
            />
          </Row>
        </fieldset>
        <SaveFeedback
          pending={limits.isPending}
          error={limits.error}
          retry={() => limits.mutate(limits.variables!)}
        />
      </Section>
      <Section title={t("While recording")}>
        <dl className="space-y-2 pt-1">
          {(
            [
              [t("Close window"), t("Recording goes on. Open Mr. Streamer again to see it.")],
              [t("Quit"), t("Asks first. Quitting stops it and keeps what was recorded.")],
              [
                t("Sleep"),
                t("Leaves a gap. The rest is recorded after waking, until its time ends."),
              ],
              [t("Updates"), t("Wait until recording ends.")],
            ] as const
          ).map(([label, what]) => (
            <div key={label} className="flex gap-4">
              <dt className="w-28 flex-none break-words text-muted-foreground">{label}</dt>
              <dd className="m-0 min-w-0 break-words">{what}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
