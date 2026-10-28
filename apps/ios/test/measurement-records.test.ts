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
        failure: { kind: "unknown", evidence: null },
      },
    });
    record({
      kind: "native",
      context,
      event: { version: 1, sequence: 23, attemptId: 52, itemId: 76, kind: "ended" },
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
  });
  it("seals at its count or elapsed boundary without inventing later observations", () => {
    for (const elapsed of [false, true]) {
      let time = 0;
      const writes: string[] = [];
      const record = measurementRecords(
        () => time,
        (json) => {
          writes.push(json);
        },
      );
      if (elapsed) time = 120_000;
      for (let i = 0; i < 300; i++) record({ kind: "foreground", active: true });
      const last = JSON.parse(writes.at(-1)!);
      expect(last.records).toHaveLength(elapsed ? 0 : 256);
      expect(last.end).toBe(elapsed ? "elapsed-limit" : "event-limit");
      expect(last.droppedAtBoundary).toBe(elapsed ? 1 : 0);
      expect(last.afterEnd).toBe("not-observed");
      expect(writes).toHaveLength(elapsed ? 1 : 256);
      expect(Buffer.byteLength(writes.at(-1)!)).toBeLessThan(100_000);
    }
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
