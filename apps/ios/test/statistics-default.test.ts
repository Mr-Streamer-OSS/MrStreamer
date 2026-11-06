import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { File, Paths, native } from "./native-files.ts";
import { Analytics } from "../src/telemetry/analytics.ts";
import { readAnalyticsRecord } from "../src/telemetry/storage.ts";
import { writeJson, removeJson } from "../src/files.ts";
import type { AnalyticsRecord, CaptureEvent } from "../src/telemetry/model.ts";

vi.mock("expo-file-system", () => import("./native-files.ts"));

const sent: CaptureEvent[] = [];

const record = (choice: AnalyticsRecord["choice"]): AnalyticsRecord => ({
  format: 1,
  choice,
  installationId: null,
  lastDay: null,
  pending: [],
  unfinished: null,
});

let sequence = 0;

function launch(configured = true) {
  return new Analytics({
    store: { load: readAnalyticsRecord, save: (value) => writeJson("analytics.json", value) },
    transport: configured
      ? {
          kind: "local",
          send: async (event) => {
            sent.push(event);

            return "accepted" as const;
          },
        }
      : null,
    build: { app_version: "0.1.0", app_build: "test", os: "ios" },
    monotonic: () => performance.now(),
    uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
}

beforeEach(() => {
  sent.length = 0;
  sequence = 0;
  removeJson("analytics.json");
});

afterEach(() => {
  native.sync = null;
  vi.restoreAllMocks();
  removeJson("analytics.json");
  vi.useRealTimers();
});

it("enables only a new install, saves the default and honors an opt-out across launch", async () => {
  const app = launch();
  expect(app.settings.get()).toEqual({ enabled: true, transport: "local" });
  expect(readAnalyticsRecord()).toMatchObject({ choice: "on" });
  app.setForeground(true);
  await vi.waitFor(() =>
    expect(sent.map((event) => event.event)).toEqual(["installation_observed", "app_active_day"]),
  );
  app.configure(false);
  app.setForeground(false);
  expect(readAnalyticsRecord()).toMatchObject({ choice: "off", pending: [], unfinished: null });
  const next = launch();
  expect(next.settings.get().enabled).toBe(false);
  next.noteAction("search_used");
  expect(sent).toHaveLength(2);
});

it.each(["on", "off", null] as const)("preserves the saved %s choice", (choice) => {
  writeJson("analytics.json", record(choice));
  expect(launch().settings.get().enabled).toBe(choice === "on");
  expect(readAnalyticsRecord()).toMatchObject({ choice });
});

it.each(["{broken", "null", JSON.stringify({ format: 99 })])(
  "fails closed without replacing corrupt storage: %s",
  (text) => {
    const file = new File(Paths.document, "analytics.json");
    file.writeSync(text);
    const app = launch();
    expect(app.settings.get()).toEqual({ enabled: false, transport: "unavailable" });
    app.noteAction("search_used");
    expect(file.textSync()).toBe(text);
    expect(sent).toEqual([]);
  },
);

it("does not fall back from unreadable saved Off to a pending On", () => {
  writeJson("analytics.json", record("off"));
  new File(Paths.document, "analytics.json.next").writeSync(JSON.stringify(record("on")));
  native.sync = (operation, path) => {
    if (operation === "text" && path.endsWith("/analytics.json")) throw new Error("unreadable");
  };

  expect(launch().settings.get()).toEqual({ enabled: false, transport: "unavailable" });
  native.sync = null;
  expect(readAnalyticsRecord()).toMatchObject({ choice: "off" });
});

it("honors a saved Off left by an interrupted write", () => {
  new File(Paths.document, "analytics.json.next").writeSync(JSON.stringify(record("off")));
  expect(launch().settings.get().enabled).toBe(false);
});

it("disables collection if the initial default cannot be saved", () => {
  native.sync = (operation) => {
    if (operation === "write") throw new Error("unwritable");
  };

  const app = launch();
  expect(app.settings.get()).toEqual({ enabled: false, transport: "unavailable" });
  app.noteAction("search_used");
  expect(sent).toEqual([]);
});

it("saves the new default without creating events in an unconfigured build", () => {
  const app = launch(false);
  app.setForeground(true);
  app.noteAction("search_used");
  app.setForeground(false);
  expect(app.settings.get()).toEqual({ enabled: true, transport: "unconfigured" });
  expect(readAnalyticsRecord()).toEqual(record("on"));
  expect(sent).toEqual([]);
});

it("does not treat an inaccessible primary file as absent when exists reports false", () => {
  writeJson("analytics.json", record("off"));
  new File(Paths.document, "analytics.json.next").writeSync(JSON.stringify(record("on")));
  vi.spyOn(File.prototype, "exists", "get").mockReturnValue(false);
  native.sync = (operation, path) => {
    if (operation === "text" && path.endsWith("/analytics.json")) throw new Error("unreadable");
  };

  expect(launch().settings.get()).toEqual({ enabled: false, transport: "unavailable" });
  expect(sent).toEqual([]);
});

it("fails closed if the documents directory cannot be listed", () => {
  vi.spyOn(Paths.document, "list").mockImplementation(() => {
    throw new Error("unreadable");
  });
  expect(launch().settings.get()).toEqual({ enabled: false, transport: "unavailable" });
  expect(sent).toEqual([]);
});
