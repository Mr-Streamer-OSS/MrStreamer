import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeNative } from "./e2e/analytics-exit.ts";
import { analyticsOptions } from "./e2e/analytics-options.ts";
import { reconcileBodies } from "./e2e/analytics-native.ts";

const sha = "a".repeat(40);
describe("native telemetry verification CLI", () => {
  it("requires independent installed version/source pins without changing source workload defaults", () => {
    expect(analyticsOptions([])).toMatchObject({ native: false, volume: false, rollover: false });
    expect(() => analyticsOptions(["/installed/app"])).toThrow("requires");
    expect(() =>
      analyticsOptions(["--expected-version=0.0.16", "--expected-source=main", "/installed/app"]),
    ).toThrow("SHA");
    expect(
      analyticsOptions([
        "--expected-version=0.0.16",
        `--expected-source=${sha}`,
        "/installed/app",
        "--",
        "--no-sandbox",
      ]),
    ).toMatchObject({
      executable: "/installed/app",
      expectedVersion: "0.0.16",
      expectedSource: sha,
      appArgs: ["--no-sandbox"],
      native: false,
    });
  });
  it("keeps expensive or installed compatibility options out of ordinary aggregate execution", () => {
    for (const flag of [
      "--native-case=periodic",
      "--installed-pair=/packages",
      "--prior-source=" + sha,
    ])
      expect(() => analyticsOptions([flag])).toThrow("require --native-telemetry");
    expect(() => analyticsOptions(["--native-telemetry", "--native-case=typo"])).toThrow(
      "Unknown native",
    );
    expect(() => analyticsOptions(["--native-telemetry", "--volume-workload"])).toThrow(
      "ordinary workload",
    );
    expect(() => analyticsOptions(["--native-telemetry", "--prior-executable=/old"])).toThrow(
      "together",
    );
  });
});
describe("ambiguous native HTTP delivery reconciliation", () => {
  const body = JSON.stringify({
    uuid: "play",
    timestamp: "2026-10-18T12:00:00Z",
    properties: { watch_duration_seconds: 8 },
  });
  it("counts byte-identical retries once while retaining the actual number of transmissions", () => {
    expect(reconcileBodies([body, body, body])).toEqual({ deliveries: 3, logicalEvents: 1 });
    expect(reconcileBodies([body, JSON.stringify({ uuid: "next" })])).toEqual({
      deliveries: 2,
      logicalEvents: 2,
    });
  });
  it("refuses the same UUID with a different timestamp, duration or serialized body", () => {
    for (const changed of [
      body.replace("12:00", "12:01"),
      body.replace(":8", ":9"),
      JSON.stringify(JSON.parse(body), null, 2),
    ])
      expect(() => reconcileBodies([body, changed])).toThrow("UUID changed");
  });
});

describe("native acceptance shutdown", () => {
  it("records a zero-code graceful exit and distinguishes forced cleanup", async () => {
    const start = async (script: string) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
      await once(child.stdout!, "data");
      return child;
    };
    const graceful = await start(
      "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));console.log('ready')",
    );
    expect(
      await closeNative(
        graceful,
        async () => {
          graceful.stdin!.end();
        },
        1000,
      ),
    ).toMatchObject({
      code: 0,
      signal: null,
      forced: false,
      alreadyExited: false,
      requestError: null,
    });
    const hanging = await start("setInterval(()=>{},1000);console.log('ready')");
    expect(await closeNative(hanging, () => new Promise(() => {}), 50)).toMatchObject({
      forced: true,
      alreadyExited: false,
    });
  });
});
