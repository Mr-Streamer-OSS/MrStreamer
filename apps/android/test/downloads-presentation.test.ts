import { expect, it } from "vitest";
import { isCopy, rowStatus, sheetChoices, trailingChoice } from "../src/downloads/presentation.ts";
import type { DownloadRow } from "../src/downloads/state.ts";

const GB = 1e9;

function row(id: string, changes: Partial<DownloadRow> = {}): DownloadRow {
  return {
    id,
    key: id,
    sourceId: "kade",
    title: id,
    sourceLabel: "Kade Stream",
    kind: "movie",
    mediaId: id,
    container: "mkv",
    state: "queued",
    bytes: 0,
    total: 2.8 * GB,
    reason: "",
    ...changes,
  };
}

it("says what reconciliation found after a restart, in red only for a failure", () => {
  const restarted = row("restarted", { state: "running", bytes: 0.14 * GB, reason: "changed" });
  expect(rowStatus(restarted, false)).toMatchObject({ failed: false });
  expect(rowStatus(restarted, false).text).toContain("started again");

  const stopped = row("stopped", { state: "failed", bytes: GB, reason: "interrupted" });
  expect(rowStatus(stopped, false)).toEqual({
    text: "The download couldn't go on from where it stopped.",
    failed: true,
    progress: null,
  });
  expect(trailingChoice(stopped)).toBe("retry");

  const blocked = row("blocked", { state: "running", bytes: GB, blocked: true });
  expect(rowStatus(blocked, false)).toEqual({
    text: "Waiting while Kade Stream plays",
    failed: false,
    progress: null,
  });
});

it("lists only a checked completion as a copy, and a missing file with its copies", () => {
  const arrived = row("arrived", { state: "running", bytes: 2.8 * GB });
  expect(isCopy(arrived)).toBe(false);
  expect(rowStatus(arrived, false).text).not.toContain("Downloaded");
  expect(trailingChoice(arrived)).toBe("pause");

  const missing = row("missing", { state: "failed", bytes: 2.8 * GB, reason: "missing" });
  expect(isCopy(missing)).toBe(true);
  expect(rowStatus(missing, false)).toMatchObject({ text: "File missing", failed: true });
  expect(trailingChoice(missing)).toBe("delete");

  const kept = row("kept", { state: "complete", bytes: 2.8 * GB });
  expect(isCopy(kept)).toBe(true);
  expect(rowStatus(kept, true)).toMatchObject({
    text: "Provider removed, copy kept",
    failed: false,
  });
  expect(trailingChoice(kept)).toBe("play");
});

it("moves a row only among those waiting", () => {
  const rows = [
    row("running", { state: "running", bytes: GB }),
    row("first"),
    row("middle", { state: "paused", bytes: GB }),
    row("last"),
  ];

  const [running, first, middle, last] = rows as [
    DownloadRow,
    DownloadRow,
    DownloadRow,
    DownloadRow,
  ];

  expect(sheetChoices(running, rows)).toEqual(["pause", "cancel"]);
  expect(sheetChoices(first, rows)).toEqual(["pause", "down", "cancel"]);
  expect(sheetChoices(middle, rows)).toEqual(["resume", "up", "down", "cancel"]);
  expect(sheetChoices(last, rows)).toEqual(["pause", "up", "cancel"]);
  expect(sheetChoices(row("disk", { state: "failed", reason: "disk" }), rows)).toEqual([
    "retry",
    "remove",
  ]);
});

it("distinguishes saved episodes with facts and keeps legacy size-only rows readable", async () => {
  const { rowFacts } = await import("../src/downloads/presentation.ts");
  expect(rowFacts(row("legacy", { total: 0 }))).toBe("");
  expect(rowFacts(row("legacy"))).toContain("GB");

  const facts = rowFacts(
    row("episode", {
      year: 2026,
      duration: 2700,
      season: 2,
      episode: 3,
      episodeName: "The crossing",
    }),
  );

  expect(facts).toContain("2026");
  expect(facts).toContain("S2 E3 · The crossing");
  expect(facts).toContain("45");
});

it("presents only the exact episode file and dispatches its state action", async () => {
  const { libraryDownload } = await import("../src/downloads/library-presentation.ts");
  const { vi } = await import("vitest");
  const act = vi.fn();

  const media = {
    sourceId: "kade",
    titleKey: "series",
    titleId: "series",
    kind: "episode" as const,
    episodeId: "one",
    version: { subscriptionId: "kade", id: "series", tags: [], container: "mkv" },
  };

  const queued = row("one", { kind: "episode" });
  const identity = media;
  expect(libraryDownload([queued], { ...identity, sourceId: "other" }, act)).toBeUndefined();
  expect(
    libraryDownload([queued], { ...identity, kind: "episode", episodeId: "two" }, act),
  ).toBeUndefined();

  for (const [state, icon, action] of [
    ["queued", "stop", "pause"],
    ["running", "stop", "pause"],
    ["paused", "empty", "resume"],
    ["failed", "retry", "retry"],
    ["complete", "done", "play"],
  ] as const) {
    const saved = { ...queued, state };
    const shown = libraryDownload([saved], identity, act);
    expect(shown?.icon).toBe(icon);
    shown?.activate();
    expect(act).toHaveBeenLastCalledWith(saved, action);
  }
});

it("keeps the successor presentation adapter when an older registration cleans up", async () => {
  const { downloadPresentationRegistry } = await import("../src/library/intents.ts");
  const registry = downloadPresentationRegistry();
  const adapter = { read: () => undefined, snapshot: () => 0, subscribe: () => () => {} };
  const first = registry.register(adapter);
  const successor = { ...adapter };
  const second = registry.register(successor);
  first();
  expect(registry.state.get()).toBe(successor);
  second();
  expect(registry.state.get()).toBeUndefined();
});
