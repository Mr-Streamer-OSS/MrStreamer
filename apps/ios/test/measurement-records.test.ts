import { describe, expect, it } from "vitest";
import { measurementRecords } from "../scripts/measurement-records.ts";

const context = { generation: 8, phase: "paused", watch: true, aside: false };
describe("fixture playback export", () => {
  it("retains native waiting independently of UI paused, sanitized identity and intent", () => {
    let output = "";
    let time = 50;
    const record = measurementRecords(
      () => time,
      (json) => {
        output = json;
      },
    );
    record({
      kind: "native",
      context,
      event: {
        version: 1,
        sequence: 21,
        attemptId: 52,
        itemId: 76,
        kind: "state",
        timeControl: "waiting",
        mediaTimeSeconds: 9,
        bufferEmpty: true,
        likelyToKeepUp: false,
      },
    });
    time = 70;
    record({ kind: "intent", context, action: "pause" });
    record({
      kind: "native",
      context,
      event: {
        version: 1,
        sequence: 22,
        attemptId: 52,
        itemId: 76,
        kind: "failure",
        terminal: true,
        failure: {
          kind: "unknown",
          evidence: {
            kind: "system",
            origin: "item",
            code: { domain: "other", code: 987654321 },
            underlying: [],
          },
        },
      },
    });
    record({
      kind: "native",
      context,
      event: { version: 1, sequence: 23, attemptId: 52, itemId: 76, kind: "ended" },
    });
    record({
      kind: "native",
      context,
      event: {
        version: 1,
        sequence: 24,
        attemptId: 52,
        itemId: 76,
        kind: "tracks",
        tracks: {
          attemptId: 52,
          itemId: 76,
          revision: 1,
          audio: {
            state: "ready",
            options: [
              {
                attemptId: 52,
                itemId: 76,
                id: "PRIVATE_TRACK",
                revision: 1,
                isDefault: true,
                isPlayable: true,
                group: "audio",
                label: "PRIVATE_LABEL",
              },
            ],
          },
          subtitles: { state: "absent", options: [] },
          subtitleOffAllowed: true,
          selectedAudioId: "PRIVATE_TRACK",
          selectedSubtitleId: null,
        },
      },
    });
    record({
      kind: "native",
      context,
      event: {
        version: 1,
        sequence: 25,
        attemptId: 52,
        itemId: null,
        kind: "detached",
        receipt: {
          kind: "detached",
          attemptId: 52,
          itemId: 76,
          localItemExcluded: true,
          appWorkDrained: true,
          providerDisconnect: "unobservable",
        },
      },
    });
    const result = JSON.parse(output);
    expect(result.nativeCallbackTime).toBe("unavailable");
    expect(result.records[0]).toMatchObject({
      kind: "state",
      timeControl: "waiting",
      context: { phase: "paused" },
      jsReceiptElapsedMs: 0,
      sequence: 21,
      attempt: 1,
      item: 2,
    });
    expect(result.records[1]).toMatchObject({
      kind: "intent",
      action: "pause",
      jsReceiptElapsedMs: 20,
    });
    expect(result.records[2]).toMatchObject({
      kind: "failure",
      failure: "unknown",
      terminal: true,
    });
    expect(result.records[3]).toMatchObject({ kind: "ended" });
    expect(output).not.toContain('"item":76');
    expect(output).not.toMatch(/987654321|PRIVATE_|receipt|evidence|selectedAudioId/);
    expect(result.records[4]).toMatchObject({ kind: "tracks", attempt: 1, item: 2 });
    expect(result.records[5]).toMatchObject({ kind: "detached", attempt: 1, item: null });
    expect(result.records[0].context.generation).toBe(result.records[4].context.generation);
    expect(result.records[0].context.generation).not.toBe(context.generation);
  });
  it.each([
    { end: "event-limit", start: 0, records: 256, dropped: 0, writes: 256 },
    { end: "elapsed-limit", start: 120_000, records: 0, dropped: 1, writes: 1 },
  ])("seals at its $end without inventing later observations", (bound) => {
    let time = 0;
    const writes: string[] = [];
    const record = measurementRecords(
      () => time,
      (json) => {
        writes.push(json);
      },
    );
    time = bound.start;
    for (let i = 0; i < 300; i++) record({ kind: "foreground", active: true });
    const last = JSON.parse(writes.at(-1)!);
    expect(last.records).toHaveLength(bound.records);
    expect(last.end).toBe(bound.end);
    expect(last.droppedAtBoundary).toBe(bound.dropped);
    expect(last.afterEnd).toBe("not-observed");
    expect(writes).toHaveLength(bound.writes);
  });
  it("never propagates export IO failure into playback", () => {
    let attempts = 0;
    const record = measurementRecords(
      () => 0,
      () => {
        attempts++;
        throw new Error("disk full");
      },
    );
    expect(() => {
      record({ kind: "foreground", active: true });
      record({ kind: "foreground", active: false });
    }).not.toThrow();
    expect(attempts).toBe(1);
  });
});
