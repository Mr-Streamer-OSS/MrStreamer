import { describe, expect, it, vi } from "vitest";
import { measurementRecords } from "../scripts/measurement-records.ts";

const context = {
  generation: 8,
  phase: "paused",
  watch: true,
  aside: false,
  pip: false,
  external: false,
} as const;
describe("fixture playback export", () => {
  it("retains native waiting independently of UI paused, sanitized identity and intent", () => {
    let output = "";
    let time = 50;
    const record = measurementRecords(
      () => time,
      (json) => {
        output = json;
      },
      { source: "synthetic", overlay: "test" },
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
    expect(result.records[2].evidence.code).toEqual({ domain: "other", code: 987654321 });
    expect(result.artifact).toEqual({ source: "synthetic", overlay: "test" });
    expect(result.records[3]).toMatchObject({ kind: "ended" });
    expect(output).not.toContain('"item":76');
    expect(output).not.toMatch(/PRIVATE_|receipt|selectedAudioId/);
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
      { source: "synthetic", overlay: "test" },
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
      { source: "synthetic", overlay: "test" },
    );
    expect(() => {
      record({ kind: "foreground", active: true });
      record({ kind: "foreground", active: false });
    }).not.toThrow();
    expect(attempts).toBe(1);
  });
  it("stops capture after projection fails while playback can continue", () => {
    const writes: string[] = [];
    const record = measurementRecords(
      () => 0,
      (json) => {
        writes.push(json);
      },
      { source: "synthetic", overlay: "test" },
    );
    record({ kind: "foreground", active: true });
    expect(() => {
      record({
        kind: "native",
        context,
        event: {
          version: 1,
          sequence: 1,
          attemptId: 52,
          itemId: 76,
          kind: "state",
          timeControl: "waiting",
          get mediaTimeSeconds(): number {
            throw new Error("unreadable native payload");
          },
          bufferEmpty: true,
          likelyToKeepUp: false,
        },
      });
      record({ kind: "foreground", active: false });
    }).not.toThrow();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).end).toBeNull();
  });
  it("exports a truthful byte-limit boundary for populated failures", () => {
    let output = "";
    const record = measurementRecords(
      () => 0,
      (json) => {
        output = json;
      },
      { source: "synthetic", overlay: "test" },
    );
    for (let sequence = 1; sequence <= 300; sequence++)
      record({
        kind: "native",
        context,
        event: {
          version: 1,
          sequence,
          attemptId: 52,
          itemId: 76,
          kind: "failure",
          terminal: false,
          failure: {
            kind: "network",
            evidence: {
              kind: "system",
              origin: "item",
              code: { domain: "url", code: -1001 },
              underlying: Array.from({ length: 12 }, () => ({ domain: "other", code: 987654321 })),
            },
          },
        },
      });
    const result = JSON.parse(output);
    expect(result.end).toBe("byte-limit");
    expect(result.droppedAtBoundary).toBe(1);
    expect(result.records[0].underlyingOmitted).toBe(4);
    expect(result.records[0].evidence.underlying).toHaveLength(8);
    expect(Buffer.byteLength(output)).toBeLessThan(64_000);
  });
  it("isolates a real adapter synchronous storage refusal without queueing async writes", async () => {
    let attempts = 0;
    vi.doMock("expo-file-system", () => ({
      Paths: { document: "fixture-documents" },
      File: class {
        writeSync() {
          attempts++;
          throw new Error("refused");
        }
      },
    }));
    const { recordMeasurement } = await import("../scripts/measurement-runtime.ts");
    expect(() => {
      recordMeasurement({ kind: "foreground", active: true });
      recordMeasurement({ kind: "foreground", active: false });
    }).not.toThrow();
    expect(attempts).toBe(1);
    vi.doUnmock("expo-file-system");
  });
});
