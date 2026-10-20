// Attribution diagnostics for measure-app.ts's probes, run in the same disposable instance:
// steady-state V8 profiles and Chromium traces of playing Live TV, Home and Watch, and the
// renderer's React Query retention across a browse churn. They read Electron's IPC registry and
// React's root fiber at runtime for diagnosis only; the product never uses either. A missing
// internal invalidates the capture rather than reporting zero work or zero bytes.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { ProcessMetric } from "electron";
import { delay, key, waitFor, type Page } from "./app.ts";

const STEADY_PROFILE_MS = 60_000;
const STEADY_TRACE_MS = 20_000;
const TRACE_CATEGORIES = [
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "v8.execute",
  "blink.user_timing",
];
// Tasks that start a thread's unit of work; nested run loops are skipped by containment.
const TOP_LEVEL_TASKS = new Set([
  "ThreadControllerImpl::RunTask",
  "ThreadPool_RunTask",
  "RunTask",
  "RunNormalPriorityTask",
]);
const electron = `process.getBuiltinModule('module').createRequire(process.execPath)('electron')`;

export type CpuProfile = {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    hitCount?: number;
    children?: number[];
  }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
};
export type TraceEvent = {
  name: string;
  cat?: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  tdur?: number;
  args?: { name?: string; data?: { functionName?: string; url?: string; lineNumber?: number } };
};

/** What the probes need from runAppProbes' verified instance. */
export type AttributionContext = {
  page: Page;
  main: Page;
  output: string;
  rendererPid: number;
  action(name: string): void;
  save(): void;
  click(text: string): Promise<void>;
  /** Opens Live TV and waits for its rows. */
  list(): Promise<void>;
  metrics(): Promise<ProcessMetric[]>;
};

async function command<T>(page: Page, method: string, params: Record<string, unknown> = {}) {
  const reply = await page.send(method, params, 120_000);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result as T;
}

/**
 * V8 self time by function, with its heaviest stacks. `(idle)`, `(program)` and
 * `(garbage collector)` stay separate: program is native embedder work outside JS, not idle.
 */
export function profileSummary(profile: CpuProfile, top = 25) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map<number, number>();
  profile.samples.forEach((id, index) =>
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)),
  );
  const sampledUs = [...self.values()].reduce((sum, value) => sum + value, 0);
  const special = { "(idle)": 0, "(program)": 0, "(garbage collector)": 0, "(root)": 0 };
  const functions = new Map<
    string,
    {
      functionName: string;
      url: string;
      lineNumber: number;
      sampledUs: number;
      stacks: Map<string, number>;
    }
  >();
  for (const [id, us] of self) {
    const { functionName, url, lineNumber } = byId.get(id)!.callFrame;
    if (functionName in special && url === "") {
      special[functionName as keyof typeof special] += us;
      continue;
    }
    const identity = `${functionName}|${url}|${lineNumber}`;
    const entry = functions.get(identity) ?? {
      functionName,
      url,
      lineNumber,
      sampledUs: 0,
      stacks: new Map<string, number>(),
    };
    functions.set(identity, entry);
    entry.sampledUs += us;
    const frames: string[] = [];
    for (let at = parent.get(id); at !== undefined && frames.length < 8; at = parent.get(at)) {
      const frame = byId.get(at)!.callFrame;
      if (frame.functionName === "(root)") break;
      frames.push(`${frame.functionName || "(anonymous)"}:${frame.lineNumber + 1}`);
    }
    const stack = frames.join(" < ");
    entry.stacks.set(stack, (entry.stacks.get(stack) ?? 0) + us);
  }
  const busyUs = sampledUs - special["(idle)"];
  return {
    durationUs: profile.endTime - profile.startTime,
    sampledUs,
    idleUs: special["(idle)"],
    programUs: special["(program)"],
    garbageCollectorUs: special["(garbage collector)"],
    javascriptUs:
      busyUs - special["(program)"] - special["(garbage collector)"] - special["(root)"],
    top: [...functions.values()]
      .sort((a, b) => b.sampledUs - a.sampledUs)
      .slice(0, top)
      .map(({ stacks, ...entry }) => ({
        ...entry,
        lineNumber: entry.lineNumber + 1,
        shareOfBusy: busyUs > 0 ? entry.sampledUs / busyUs : 0,
        stacks: [...stacks]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([stack, us]) => ({ stack, sampledUs: us })),
      })),
  };
}

/**
 * Thread time of each thread's outermost tasks, and the window's main-thread timeline events.
 * `tdur` is the thread's CPU time inside traced tasks; work outside them is not attributed, and a
 * thread whose tasks lack `tdur` is unsupported rather than zero.
 */
export function traceSummary(events: readonly TraceEvent[], rendererPid: number, top = 25) {
  const processes = new Map<number, string>();
  const threads = new Map<string, string>();
  for (const event of events) {
    if (event.ph !== "M") continue;
    if (event.name === "process_name") processes.set(event.pid, event.args?.name ?? "");
    if (event.name === "thread_name")
      threads.set(`${event.pid}:${event.tid}`, event.args?.name ?? "");
  }
  const tasks = new Map<string, TraceEvent[]>();
  for (const event of events)
    if (event.ph === "X" && TOP_LEVEL_TASKS.has(event.name)) {
      const thread = `${event.pid}:${event.tid}`;
      tasks.set(thread, [...(tasks.get(thread) ?? []), event]);
    }
  const perThread = [...tasks].map(([thread, list]) => {
    list.sort((a, b) => a.ts - b.ts);
    let end = -Infinity,
      count = 0,
      wallUs = 0,
      cpuUs = 0,
      unsupported = false;
    for (const task of list) {
      if (task.ts < end) continue;
      end = task.ts + (task.dur ?? 0);
      count++;
      wallUs += task.dur ?? 0;
      if (task.tdur === undefined) unsupported = true;
      else cpuUs += task.tdur;
    }
    const [pid] = thread.split(":").map(Number);
    return {
      pid: pid!,
      process: processes.get(pid!) ?? "unknown",
      thread: threads.get(thread) ?? "unknown",
      renderer: pid === rendererPid,
      tasks: count,
      wallMs: wallUs / 1000,
      cpu: unsupported
        ? { status: "unsupported" as const, reason: "Outer task without thread duration" }
        : { status: "supported" as const, ms: cpuUs / 1000 },
    };
  });
  const mainThread = [...threads].find(
    ([thread, name]) => name === "CrRendererMain" && thread.startsWith(`${rendererPid}:`),
  )?.[0];
  const timeline = new Map<string, { count: number; wallMs: number; cpuMs: number }>();
  const scripts = new Map<string, { count: number; wallMs: number; cpuMs: number }>();
  for (const event of events) {
    if (`${event.pid}:${event.tid}` !== mainThread || event.ph !== "X") continue;
    if (!event.cat?.includes("devtools.timeline") || TOP_LEVEL_TASKS.has(event.name)) continue;
    const add = (map: typeof timeline, name: string) => {
      const entry = map.get(name) ?? { count: 0, wallMs: 0, cpuMs: 0 };
      map.set(name, entry);
      entry.count++;
      entry.wallMs += (event.dur ?? 0) / 1000;
      entry.cpuMs += (event.tdur ?? 0) / 1000;
    };
    add(timeline, event.name);
    const data = event.args?.data;
    if ((event.name === "FunctionCall" || event.name === "TimerFire") && data)
      add(
        scripts,
        `${event.name} ${data.functionName || "(anonymous)"}:${(data.lineNumber ?? -1) + 1}`,
      );
  }
  const ranked = (map: typeof timeline) =>
    [...map]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => b.cpuMs - a.cpuMs)
      .slice(0, top);
  return {
    scope:
      "Outer task thread time per traced thread; nested timeline events are inclusive, so their times overlap",
    threads: perThread.sort(
      (a, b) =>
        (b.cpu.status === "supported" ? b.cpu.ms : -1) -
        (a.cpu.status === "supported" ? a.cpu.ms : -1),
    ),
    rendererMainThread: mainThread ?? null,
    rendererMainTimeline: ranked(timeline),
    rendererMainScripts: ranked(scripts),
  };
}

/** Counts every invoke handler call, and with `bytes` the JSON size of its replies. */
async function countIpc(main: Page, bytes: boolean): Promise<void> {
  await main.evaluate(`(() => {
    const { ipcMain } = ${electron};
    const handlers = ipcMain._invokeHandlers;
    if (!(handlers instanceof Map)) throw new Error("Electron IPC diagnostic registry unavailable");
    globalThis.__probeIpcBytes = ${bytes};
    if (globalThis.__probeIpc) return;
    const calls = globalThis.__probeIpc = new Map();
    for (const [method, handler] of handlers) handlers.set(method, async (event, ...args) => {
      const entry = calls.get(method) ?? { calls: 0, failures: 0, requestChannels: 0, replyBytes: 0, unsized: 0 };
      calls.set(method, entry);
      entry.calls++;
      if (Array.isArray(args[0]?.channels)) entry.requestChannels += args[0].channels.length;
      try {
        const reply = await handler(event, ...args);
        if (globalThis.__probeIpcBytes) {
          try { entry.replyBytes += Buffer.byteLength(JSON.stringify(reply) ?? ""); } catch { entry.unsized++; }
        }
        return reply;
      } catch (error) { entry.failures++; throw error; }
    });
  })()`);
}

/** The calls counted since the last read, by method. */
function takeIpc(main: Page) {
  return main.evaluate<Record<string, { calls: number; replyBytes: number }>>(
    `(() => { const calls = Object.fromEntries(globalThis.__probeIpc); globalThis.__probeIpc.clear(); return calls; })()`,
  );
}

async function playing(page: Page) {
  return page.evaluate<{ currentTime: number; paused: boolean; width: number }[]>(
    `[...document.querySelectorAll('video')].map(v => ({ currentTime: v.currentTime, paused: v.paused, width: v.videoWidth }))`,
  );
}

async function traceTo(page: Page, path: string, ms: number) {
  await command(page, "Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: { recordMode: "recordAsMuchAsPossible", includedCategories: TRACE_CATEGORIES },
  });
  await delay(ms);
  const complete = new Promise<{ stream: string }>((resolve) =>
    page.on("Tracing.tracingComplete", (params) => resolve(params as { stream: string })),
  );
  await command(page, "Tracing.end");
  const { stream } = await complete;
  writeFileSync(path, "");
  for (;;) {
    const chunk = await command<{ data: string; eof: boolean; base64Encoded?: boolean }>(
      page,
      "IO.read",
      { handle: stream, size: 4 << 20 },
    );
    appendFileSync(path, chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
    if (chunk.eof) break;
  }
  await command(page, "IO.close", { handle: stream });
}

/**
 * For playing Live TV (All channels with its compact preview), Home's preview and Watch over
 * Live TV: a 60-second main and renderer V8 profile with the invoke calls made in it, then a
 * separate 20-second Chromium trace without the profiler. The profiler and tracing add work, so
 * these windows explain where time goes; the idle CPU windows remain the CPU observation.
 */
export async function steadyProfiles(
  context: AttributionContext,
  record: ReturnType<typeof steadyRecord>,
): Promise<void> {
  const { page, main, output } = context;
  await countIpc(main, false);
  for (const state of ["live", "watch", "home"] as const) {
    if (state === "live") await context.list();
    if (state === "watch") {
      await context.click("Watch");
      await waitFor(() =>
        page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"]')`),
      );
    }
    if (state === "home") {
      await key(page, "Escape", 27);
      await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[data-view="watch"]')`));
      await context.click("Home");
      await waitFor(() =>
        page.evaluate<boolean>(`!!document.querySelector("[data-home-preview] h2")`),
      );
    }
    await delay(2_000);
    const before = await playing(page);
    if (!before.some((video) => !video.paused && video.width > 0))
      throw new Error(`No playing picture before the ${state} steady profile`);
    await takeIpc(main);
    context.action(`Begin ${state} steady profile`);
    const targets = [
      ["main", main],
      ["renderer", page],
    ] as const;
    for (const [, target] of targets) {
      await command(target, "Profiler.enable");
      await command(target, "Profiler.setSamplingInterval", { interval: 1_000 });
      await command(target, "Profiler.start");
    }
    await delay(STEADY_PROFILE_MS);
    const profiles: unknown[] = [];
    for (const [role, target] of targets) {
      const { profile } = await command<{ profile: CpuProfile }>(target, "Profiler.stop");
      await command(target, "Profiler.disable");
      if (!profile?.samples?.length) throw new Error(`Empty ${state} ${role} CPU profile`);
      const path = `${output}.steady-${state}.${role}.cpuprofile`;
      writeFileSync(path, JSON.stringify(profile));
      profiles.push({ role, path, intervalUs: 1_000, summary: profileSummary(profile) });
    }
    const ipc = await takeIpc(main);
    context.action(`Trace ${state} for ${STEADY_TRACE_MS / 1000} seconds`);
    const tracePath = `${output}.steady-${state}.trace.json`;
    await traceTo(page, tracePath, STEADY_TRACE_MS);
    const trace = JSON.parse(readFileSync(tracePath, "utf8")) as { traceEvents: TraceEvent[] };
    const after = await playing(page);
    if (
      !after.some(
        (video, index) =>
          !video.paused && video.currentTime > (before[index]?.currentTime ?? Infinity),
      )
    )
      throw new Error(`Playback stopped during the ${state} steady profile`);
    record.windows.push({
      state,
      profileMs: STEADY_PROFILE_MS,
      profiles,
      ipcDuringProfile: ipc,
      trace: {
        path: tracePath,
        ms: STEADY_TRACE_MS,
        categories: TRACE_CATEGORIES,
        summary: traceSummary(trace.traceEvents, context.rendererPid),
      },
    });
    context.save();
  }
}

/** The steady windows so far, saved with the probe file as each completes. */
export const steadyRecord = () => ({
  scope:
    "V8 isolate samples of main and the window's renderer (no workers, native, GPU or paint); trace thread time of traced tasks across the browser's processes. Invoke counts cover ipcMain.handle replies only.",
  windows: [] as unknown[],
});

// The renderer's QueryClient, found under React's root container fiber by its provider's prop.
const QUERY_CLIENT = `(() => {
  const root = document.getElementById('root');
  const container = root && Object.keys(root).find(name => name.startsWith('__reactContainer$'));
  const stack = container ? [root[container]] : [];
  let client;
  while (stack.length && !client) {
    const fiber = stack.pop();
    const candidate = fiber.memoizedProps?.client;
    if (candidate && typeof candidate.getQueryCache === 'function') client = candidate;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  if (!client) throw new Error('React Query client unavailable');
  return client;
})()`;
const QUERY_INVENTORY = `(() => {
  const encoder = new TextEncoder();
  return ${QUERY_CLIENT}.getQueryCache().getAll().map(query => {
    const json = query.state.data === undefined ? undefined : JSON.stringify(query.state.data);
    const data = query.state.data;
    return {
      family: query.queryKey.slice(0, 2).map(String).join('/'),
      key: query.queryHash.slice(0, 240),
      observers: query.getObserversCount(),
      active: query.isActive(),
      gcTimeMs: query.gcTime,
      status: query.state.status,
      dataUpdatedAt: query.state.dataUpdatedAt,
      dataBytes: json === undefined ? 0 : encoder.encode(json).length,
      channels: Array.isArray(data?.channels) ? data.channels.length : Array.isArray(data) ? data.length : null,
    };
  });
})()`;

type QueryEntry = {
  family: string;
  key: string;
  observers: number;
  active: boolean;
  gcTimeMs: number;
  dataBytes: number;
  channels: number | null;
};

/** Families of queries by activity, with the JSON UTF-8 size of their data. */
function inventorySummary(entries: readonly QueryEntry[]) {
  const families = new Map<
    string,
    {
      entries: number;
      inactive: number;
      dataBytes: number;
      inactiveDataBytes: number;
      channels: number;
      inactiveChannels: number;
    }
  >();
  for (const entry of entries) {
    const family = families.get(entry.family) ?? {
      entries: 0,
      inactive: 0,
      dataBytes: 0,
      inactiveDataBytes: 0,
      channels: 0,
      inactiveChannels: 0,
    };
    families.set(entry.family, family);
    family.entries++;
    family.dataBytes += entry.dataBytes;
    family.channels += entry.channels ?? 0;
    if (!entry.active) {
      family.inactive++;
      family.inactiveDataBytes += entry.dataBytes;
      family.inactiveChannels += entry.channels ?? 0;
    }
  }
  const total = (field: "dataBytes" | "inactiveDataBytes") =>
    [...families.values()].reduce((sum, family) => sum + family[field], 0);
  return {
    entries: entries.length,
    inactive: entries.filter((entry) => !entry.active).length,
    dataBytes: total("dataBytes"),
    inactiveDataBytes: total("inactiveDataBytes"),
    families: Object.fromEntries([...families].sort((a, b) => b[1].dataBytes - a[1].dataBytes)),
  };
}

async function collectedHeap(target: Page) {
  // Two passes let weakly held and finalized objects go before reading.
  await command(target, "HeapProfiler.collectGarbage");
  await command(target, "HeapProfiler.collectGarbage");
  return command<{ usedSize: number; totalSize: number }>(target, "Runtime.getHeapUsage");
}

async function heapSnapshotTo(page: Page, path: string) {
  writeFileSync(path, "");
  const stop = page.on("HeapProfiler.addHeapSnapshotChunk", (params) =>
    appendFileSync(path, (params as { chunk: string }).chunk),
  );
  try {
    await command(page, "HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    stop();
  }
}

/**
 * Browses every Live TV topic, the first country's provider lists, a country filter and the guide
 * grid, then Movies and Series with one details sheet each, and records the renderer's query cache,
 * collected main/renderer heaps, working sets and invoke replies at each lifecycle point: through
 * the churn, back on Home, after a warm return to Live TV, once React Query's own garbage
 * collection time has passed, and after a cold return. One renderer heap snapshot is retained at
 * the point of most inactive data.
 */
export async function queryRetention(
  context: AttributionContext,
  record: ReturnType<typeof retentionRecord>,
): Promise<void> {
  const { page, main, output } = context;
  const { points, returns } = record;
  await countIpc(main, true);
  await takeIpc(main);
  const picker = `document.querySelector('[role=navigation][aria-label="Channel categories"]')`;
  const header = (text: string) =>
    page.evaluate(
      `[...document.querySelectorAll("header button")].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
    );
  const heading = () =>
    page.evaluate<string>(`document.querySelector('main h1')?.textContent ?? ''`);
  const rows = () =>
    page.evaluate<boolean>(`document.querySelectorAll('main [data-index]').length > 0`);
  const entry = async (title: string) => {
    context.action(`Pick ${title}`);
    await page.evaluate(
      `(() => { const b = ${picker}.querySelector('button[title=' + ${JSON.stringify(JSON.stringify(title))} + ']'); if (!b) throw new Error('Missing list ' + ${JSON.stringify(title)}); b.click(); })()`,
    );
  };
  // A list has settled once no browse read is under way and it shows rows or says it has none.
  const settled = async () => {
    await waitFor(() =>
      page.evaluate<boolean>(
        `${QUERY_CLIENT}.isFetching({ queryKey: ['library', 'browse'] }) === 0 && (document.querySelectorAll('main [data-index]').length > 0 || document.querySelector('main')?.innerText.includes('No channels.'))`,
      ),
    );
    await delay(500);
  };
  const point = async (name: string) => {
    const entries = await page.evaluate<QueryEntry[]>(QUERY_INVENTORY, 60_000);
    const renderer = await collectedHeap(page);
    const mainHeap = await collectedHeap(main);
    const mainMemory = await main.evaluate<NodeJS.MemoryUsage>(`process.memoryUsage()`);
    const workingSets = (await context.metrics()).map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      renderer: metric.pid === context.rendererPid,
      workingSetKB: metric.memory.workingSetSize,
      privateKB: metric.memory.privateBytes ?? null,
    }));
    points.push({
      name,
      at: new Date().toISOString(),
      queries: inventorySummary(entries),
      entries,
      rendererHeap: renderer,
      mainHeap,
      mainMemory,
      workingSets,
      ipcSincePrevious: await takeIpc(main),
    });
    context.action(`Inventory ${name}`);
  };
  const timedReturn = async (name: string) => {
    await header("Home");
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("[data-home-preview]")`));
    await delay(1_000);
    await takeIpc(main);
    const started = performance.now();
    await header("Live TV");
    await waitFor(() => rows(), 60_000);
    returns.push({ name, rowsShownMs: performance.now() - started, ipc: await takeIpc(main) });
    context.save();
  };

  await context.list();
  await entry("All channels");
  await waitFor(async () => (await heading()) === "All channels" && (await rows()));
  await point("live-all");
  const root = await page.evaluate<string[]>(
    `[...${picker}.querySelectorAll('[data-entry]')].map(b => b.title)`,
  );
  const topics = root
    .slice(root.indexOf("All channels") + 1)
    .filter((title) => !["Favourites", "Recently watched", "Provider lists"].includes(title));
  for (const topic of topics) {
    await entry(topic);
    await settled();
  }
  await entry("Provider lists");
  await waitFor(() =>
    page.evaluate<boolean>(`!!${picker}.querySelector('button[aria-label="Back to topics"]')`),
  );
  // Groups open with a chevron; categories outside any country list sit beside them.
  const [country] = await page.evaluate<string[]>(
    `[...${picker}.querySelectorAll('[data-entry]')].filter(b => b.querySelector('svg.lucide-chevron-right')).map(b => b.title)`,
  );
  if (!country) throw new Error("No provider list groups");
  await entry(country);
  await waitFor(() =>
    page.evaluate<boolean>(`!!${picker}.querySelector('button[aria-label="Back to countries"]')`),
  );
  const categories = (
    await page.evaluate<string[]>(
      `[...${picker}.querySelectorAll('[data-entry]')].map(b => b.title)`,
    )
  ).slice(0, 4);
  for (const category of categories) {
    await entry(category);
    await settled();
  }
  context.action("Open and close the guide grid");
  await key(page, "g", 71);
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[role="grid"]')`));
  await delay(1_000);
  await key(page, "g", 71);
  await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[role="grid"]')`));
  await page.evaluate(`${picker}.querySelector('button[aria-label="Back to countries"]').click()`);
  await page.evaluate(`${picker}.querySelector('button[aria-label="Back to topics"]').click()`);
  await entry("All channels");
  await settled();
  const filter = `document.querySelector('[data-browse-filter=countries]')`;
  if (await page.evaluate<boolean>(`!!${filter}`)) {
    for (const pass of ["Apply", "Clear"]) {
      context.action(`${pass} the first country filter`);
      await page.evaluate(`${filter}.click()`);
      await waitFor(() =>
        page.evaluate<boolean>(`!!document.querySelector('[role=menu] [role=menuitemcheckbox]')`),
      );
      await page.evaluate(`document.querySelector('[role=menu] [role=menuitemcheckbox]').click()`);
      await delay(300);
      // Escape on the page itself would leave Live TV; close only a menu still open.
      if (await page.evaluate<boolean>(`!!document.querySelector('[role=menu]')`))
        await key(page, "Escape", 27);
      await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[role=menu]')`));
      await settled();
    }
  }
  await point("after-live-churn");
  for (const [kind, tab, title] of [
    ["Movies", "All movies", "TEST | Index at the end"],
    ["Series", "All series", "Long-running"],
  ] as const) {
    await header(kind);
    const all = `[...document.querySelectorAll("nav button")].find(b => b.textContent.trim() === ${JSON.stringify(tab)})`;
    await waitFor(() => page.evaluate<boolean>(`!!${all}`), 30_000);
    await page.evaluate(`${all}.click()`);
    const poster = `[...document.querySelectorAll("button[title]")].find(b => b.title.includes(${JSON.stringify(title)}))`;
    await waitFor(() => page.evaluate<boolean>(`!!${poster}`), 30_000);
    await delay(1_000);
    context.action(`Open ${kind} details`);
    await page.evaluate(`${poster}.click()`);
    await waitFor(
      () => page.evaluate<boolean>(`!!document.querySelector('[role=dialog] h2')`),
      30_000,
    );
    await delay(2_000);
    await key(page, "Escape", 27);
    await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[role=dialog]')`));
  }
  await point("after-ondemand-churn");
  await header("Home");
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("[data-home-preview]")`));
  await delay(2_000);
  await point("home");
  await timedReturn("warm return to Live TV");
  await header("Home");
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("[data-home-preview]")`));
  await delay(2_000);
  await point("home-after-warm-return");
  record.workload = {
    topics,
    country,
    categories,
    filters: "first country option applied, then cleared",
  };
  const snapshot = `${output}.retention.heapsnapshot`;
  context.action("Renderer heap snapshot");
  await heapSnapshotTo(page, snapshot);
  record.heapSnapshot = snapshot;
  // React Query's own gcTime decides when inactive data goes; wait for the longest one seen.
  const gcTimeMs = Math.max(
    ...(await page.evaluate<QueryEntry[]>(QUERY_INVENTORY, 60_000))
      .filter((query) => !query.active && Number.isFinite(query.gcTimeMs))
      .map((query) => query.gcTimeMs),
    0,
  );
  record.gcWaitMs = gcTimeMs + 15_000;
  context.action(`Wait ${record.gcWaitMs} ms for query garbage collection`);
  await delay(gcTimeMs + 15_000);
  await point("home-after-query-gc");
  await timedReturn("cold return to Live TV");
  await point("live-after-cold-return");
}

/** The retention points so far, saved with the probe file as each is taken. */
export const retentionRecord = () => ({
  scope:
    "Renderer React Query cache via React's root fiber; JSON UTF-8 bytes of query data are a serialization size, not heap retention. Heaps are V8 used size after two collections; worker isolates are excluded. Working sets are Electron's per-process memory.",
  workload: null as unknown,
  gcWaitMs: null as number | null,
  heapSnapshot: null as string | null,
  points: [] as unknown[],
  returns: [] as unknown[],
});
