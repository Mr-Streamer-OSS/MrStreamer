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
