import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  profileSummary,
  queryRetention,
  retentionRecord,
  steadyProfiles,
  steadyRecord,
  traceSummary,
  type AttributionContext,
  type CpuProfile,
  type TraceEvent,
} from "./app-attribution.ts";
import { connect, type Page } from "./app.ts";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("reports CDP session closure, supports listener disposal and settles pending commands", async () => {
  vi.useFakeTimers();
  const sockets: EventTarget[] = [];
  class Socket extends EventTarget {
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send() {}
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", async () => ({
    json: async () => [
      {
        type: "page",
        url: "file:///owned/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1/owned",
      },
    ],
  }));
  const connecting = connect(12345);
  await vi.advanceTimersByTimeAsync(200);
  const page = await connecting;
  const removed = vi.fn();
  page.onClose(removed)();
  const closed = vi.fn();
  page.onClose(closed);
  const pending = page.send("Tracing.end");
  sockets[0]!.dispatchEvent(new Event("close"));
  await expect(pending).resolves.toMatchObject({ error: "DevTools connection closed" });
  expect(removed).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledOnce();
  const late = vi.fn();
  page.onClose(late)();
  expect(late).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

function profile(): CpuProfile {
  return {
    nodes: [{ id: 1, callFrame: { functionName: "work", url: "app.js", lineNumber: 0 } }],
    samples: [1],
    timeDeltas: [1000],
    startTime: 10,
    endTime: 1010,
  };
}
const metadata: TraceEvent = {
  name: "thread_name",
  ph: "M",
  pid: 7,
  tid: 1,
  ts: 0,
  args: { name: "CrRendererMain" },
};
const task: TraceEvent = { name: "RunTask", ph: "X", pid: 7, tid: 1, ts: 0, dur: 4000, tdur: 3000 };

it.each<[string, (value: CpuProfile) => void]>([
  [
    "missing deltas",
    (p) => {
      p.timeDeltas = [];
    },
  ],
  [
    "mismatched deltas",
    (p) => {
      p.timeDeltas.push(1000);
    },
  ],
  [
    "nonfinite deltas",
    (p) => {
      p.timeDeltas[0] = NaN;
    },
  ],
  [
    "negative deltas",
    (p) => {
      p.timeDeltas[0] = -1;
    },
  ],
  [
    "zero sampled interval",
    (p) => {
      p.timeDeltas[0] = 0;
    },
  ],
  [
    "empty samples",
    (p) => {
      p.samples = [];
      p.timeDeltas = [];
    },
  ],
  [
    "nonfinite interval",
    (p) => {
      p.endTime = Infinity;
    },
  ],
  [
    "reversed interval",
    (p) => {
      p.endTime = p.startTime;
    },
  ],
  [
    "empty nodes",
    (p) => {
      p.nodes = [];
    },
  ],
  [
    "unknown sample",
    (p) => {
      p.samples[0] = 2;
    },
  ],
  [
    "duplicate node",
    (p) => {
      p.nodes.push(p.nodes[0]!);
    },
  ],
  [
    "unknown child",
    (p) => {
      p.nodes[0]!.children = [2];
    },
  ],
  [
    "cyclic ancestry",
    (p) => {
      p.nodes[0]!.children = [1];
    },
  ],
])("rejects a CPU profile with %s instead of reporting zero work", (_, change) => {
  const value = profile();
  change(value);
  expect(() => profileSummary(value)).toThrow(/CPU profile/);
});

it("retains count and wall time for missing/partial timeline and script CPU", () => {
  const call = (name: string, tdur?: number): TraceEvent => ({
    name: "FunctionCall",
    cat: "devtools.timeline",
    ph: "X",
    pid: 7,
    tid: 1,
    ts: 10,
    dur: 1000,
    ...(tdur === undefined ? {} : { tdur }),
    args: { data: { functionName: name, lineNumber: 4 } },
  });
  const result = traceSummary(
    [metadata, task, call("missing"), call("partial", 300), call("partial")],
    7,
  );
  expect(result.rendererMainTimeline).toEqual([
    {
      name: "FunctionCall",
      count: 3,
      wallMs: 3,
      cpuMs: null,
      cpu: { status: "partial", observedMs: 0.3, observedEvents: 1, missingEvents: 2 },
    },
  ]);
  expect(result.rendererMainScripts).toEqual([
    {
      name: "FunctionCall partial:5",
      count: 2,
      wallMs: 2,
      cpuMs: null,
      cpu: { status: "partial", observedMs: 0.3, observedEvents: 1, missingEvents: 1 },
    },
    {
      name: "FunctionCall missing:5",
      count: 1,
      wallMs: 1,
      cpuMs: null,
      cpu: { status: "unsupported", observedMs: 0, observedEvents: 0, missingEvents: 1 },
    },
  ]);
  const ranked = traceSummary(
    [metadata, task, call("partial", 3000), call("partial"), call("supported", 100)],
    7,
  );
  expect(ranked.rendererMainScripts[0]).toMatchObject({
    name: "FunctionCall supported:5",
    cpuMs: 0.1,
  });
});

it("counts equal-start nested tasks outermost first regardless of event order", () => {
  const inner = { ...task, dur: 1000, tdur: 900 };
  const first = traceSummary([metadata, inner, task], 7);
  expect(first).toEqual(traceSummary([task, metadata, inner], 7));
  expect(first.threads[0]).toMatchObject({
    tasks: 1,
    wallMs: 4,
    cpu: { status: "supported", ms: 3 },
  });
});

it.each([[], [metadata], [task], [{ ...metadata, pid: 8 }, task]].map((events) => ({ events })))(
  "rejects a trace without the expected renderer's main-thread tasks %#",
  ({ events }) => {
    expect(() => traceSummary(events, 7)).toThrow(/trace/);
  },
);

/** A protocol peer with controlled capture failures; it launches no app. */
function capture(mode = "success", capturedProfile = profile(), events = [metadata, task]) {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "attribution-contract-"));
  directories.push(directory);
  const listeners = new Map<string, (params: unknown) => void>();
  const closes = new Set<() => void>();
  const calls: string[] = [];
  let clock = 0;
  const page: Page = {
    async send(method) {
      calls.push(method);
      if (method === "Profiler.stop") return { result: { profile: capturedProfile } };
      if (method === "Tracing.end") {
        if (mode === "end-error") return { error: "end refused" };
        if (mode === "invalid-completion") listeners.get("Tracing.tracingComplete")?.({});
        else if (mode === "closed") for (const listener of closes) listener();
        else if (mode !== "missing-completion")
          listeners.get("Tracing.tracingComplete")?.({ stream: "trace-stream" });
      }
      if (method === "IO.read") {
        if (mode === "read-error") return { error: "read refused" };
        if (mode === "stream-deadline") {
          vi.advanceTimersByTime(60_001);
          return { result: { data: "partial", eof: false } };
        }
        return { result: { data: JSON.stringify({ traceEvents: events }), eof: true } };
      }
      return { result: {} };
    },
    on(method, listener) {
      listeners.set(method, listener);
      return () => {
        listeners.delete(method);
      };
    },
    onClose(listener) {
      closes.add(listener);
      return () => {
        closes.delete(listener);
      };
    },
    async evaluate<T>(expression: string): Promise<T> {
      let result: unknown = true;
      if (expression.includes("querySelectorAll('video')"))
        result = [{ currentTime: ++clock, paused: false, width: 1280 }];
      else if (expression.includes("Object.fromEntries")) result = {};
      return result as T;
    },
    close: vi.fn(),
  };
  const context: AttributionContext = {
    page,
    main: page,
    output: join(directory, "capture"),
    rendererPid: 7,
    action: vi.fn(),
    save: vi.fn(),
    click: vi.fn(),
    list: vi.fn(),
    metrics: async () => [],
  };
  return { context, page, directory, calls, listeners, closes };
}

it.each([
  ["missing-completion", "Trace completion timed out"],
  ["closed", "DevTools session closed"],
  ["end-error", "end refused"],
  ["read-error", "read refused"],
  ["invalid-completion", "Trace completion has no IO stream"],
  ["stream-deadline", "Trace IO stream exceeded 120 s"],
])(
  "rejects %s and reaches the owning caller's teardown with no trace listeners",
  async (mode, message) => {
    const peer = capture(mode);
    const result = steadyProfiles(peer.context, steadyRecord()).finally(() => peer.page.close());
    const rejected = expect(result).rejects.toThrow(message);
    await vi.runAllTimersAsync();
    await rejected;
    expect(peer.page.close).toHaveBeenCalledOnce();
    expect(peer.listeners.size).toBe(0);
    expect(peer.closes.size).toBe(0);
    if (mode === "read-error" || mode === "stream-deadline")
      expect(peer.calls).toContain("IO.close");
  },
);

it("retains failed raw profiles and rejects incomplete captures", async () => {
  const invalid = profile();
  invalid.timeDeltas = [];
  const peer = capture("success", invalid);
  const result = expect(steadyProfiles(peer.context, steadyRecord())).rejects.toThrow(
    /CPU profile/,
  );
  await vi.runAllTimersAsync();
  await result;
  expect(
    JSON.parse(readFileSync(`${peer.context.output}.steady-live.main.cpuprofile`, "utf8")),
  ).toEqual(invalid);
});

it("rejects a captured empty trace and retains its raw file", async () => {
  const peer = capture("success", profile(), []);
  const result = expect(steadyProfiles(peer.context, steadyRecord())).rejects.toThrow(/trace/);
  await vi.runAllTimersAsync();
  await result;
  expect(JSON.parse(readFileSync(`${peer.context.output}.steady-live.trace.json`, "utf8"))).toEqual(
    { traceEvents: [] },
  );
  expect(peer.calls).toContain("IO.close");
});

it("records ISO wall-clock brackets for each profile and the separate trace", async () => {
  const peer = capture();
  const record = steadyRecord();
  const result = steadyProfiles(peer.context, record);
  await vi.runAllTimersAsync();
  await result;
  expect(record.windows).toHaveLength(3);
  for (const window of record.windows as {
    startedAt: string;
    endedAt: string;
    profiles: { startedAt: string; endedAt: string }[];
    trace: { startedAt: string; endedAt: string };
  }[]) {
    expect(Date.parse(window.endedAt) - Date.parse(window.startedAt)).toBe(60_000);
    for (const profile of window.profiles) {
      expect(new Date(profile.startedAt).toISOString()).toBe(profile.startedAt);
      expect(Date.parse(profile.endedAt) - Date.parse(profile.startedAt)).toBe(60_000);
    }
    expect(Date.parse(window.trace.startedAt)).toBeGreaterThanOrEqual(Date.parse(window.endedAt));
    expect(Date.parse(window.trace.endedAt) - Date.parse(window.trace.startedAt)).toBe(20_000);
  }
  expect(peer.listeners.size + peer.closes.size).toBe(0);
});

it("records calibrated renderer-observed retention returns", async () => {
  const peer = capture();
  peer.page.evaluate = async <T>(expression: string): Promise<T> => {
    let result: unknown = true;
    if (expression.includes("new Promise")) result = expression.includes('=== "Live TV"') ? 17 : 10;
    else if (expression === "window.__calibrationActual") result = 10;
    else if (expression.includes("getQueryCache().getAll()")) result = [];
    else if (expression.includes("Object.fromEntries")) result = {};
    else if (expression.includes("main h1")) result = "All channels";
    else if (expression.includes(".map(b => b.title)")) result = ["All channels", "United Kingdom"];
    else if (
      expression.includes("[role=menu]") ||
      expression.includes("!!document.querySelector('[data-browse-filter=countries]')")
    )
      result = false;
    return result as T;
  };
  const record = retentionRecord();
  const result = expect(queryRetention(peer.context, record)).resolves.toBeUndefined();
  await vi.runAllTimersAsync();
  await result;
  expect(record.returnTiming).toMatchObject({
    method: "renderer-mutation-and-probe",
    configuredResolutionMs: 5,
  });
  expect(record.returnTiming.calibration).toHaveLength(24);
  expect(record.returns).toEqual([
    { name: "warm return to Live TV", rowsShownMs: 17, ipc: {} },
    { name: "cold return to Live TV", rowsShownMs: 17, ipc: {} },
  ]);
});
