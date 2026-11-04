import { describe, expect, it } from "vitest";
import { groups, reconcile, reminderId, rowStatus } from "../src/reminders/rules.ts";

const saved = {
  id: "one",
  sourceId: "p",
  channelId: "c",
  channelName: "Channel",
  start: 200,
  stop: 400,
  title: "News",
  status: "scheduled" as const,
  delivered: false,
  language: "en",
};

describe("saved programme reminders", () => {
  it("reconciles saved reminders with the guide and their providers", () => {
    expect(reconcile(saved, undefined, true, 100)).toEqual({ id: "one", status: "scheduled" });
    expect(reconcile(saved, { start: 200, stop: 400, title: "Film" }, true, 100)).toEqual({
      id: "one",
      status: "changed",
      changedTitle: "Film",
    });
    expect(reconcile(saved, null, true, 100)).toEqual({ id: "one", status: "missing" });
    expect(reconcile(saved, undefined, false, 100)).toEqual({ id: "one", remove: true });
    expect(reconcile(saved, undefined, true, 400)).toEqual({ id: "one", remove: true });
    expect(reconcile({ ...saved, status: "missing" }, undefined, true, 100)).toEqual({
      id: "one",
      status: "missing",
    });
    expect(reconcile({ ...saved, status: "missing" }, saved, true, 100)).toEqual({
      id: "one",
      status: "scheduled",
      stop: 400,
    });
  });
  it("groups in local day/start order and names exceptional row states", () => {
    const tomorrow = new Date(2026, 10, 5, 12).getTime();
    const today = new Date(2026, 10, 4, 12).getTime();
    expect(
      groups([
        { ...saved, start: tomorrow },
        { ...saved, start: today },
      ]).map((g) => g.rows[0]!.start),
    ).toEqual([today, tomorrow]);
    expect(rowStatus(saved, 300)).toBe("on-now");
    expect(rowStatus({ ...saved, status: "missing" }, 100)).toBe("missing");
    expect(rowStatus(saved, 100)).toBe("scheduled");
  });
  it("identifies programmes by provider, channel and start without delimiter collisions", () => {
    expect(reminderId({ sourceId: "a:b", channelId: "c" }, 1)).not.toBe(
      reminderId({ sourceId: "a", channelId: "b:c" }, 1),
    );
  });
});

it("keeps an end-time correction eligible and updates its stop", () => {
  expect(reconcile(saved, { ...saved, stop: 500 }, true, 100)).toEqual({
    id: "one",
    status: "scheduled",
    stop: 500,
  });
});
