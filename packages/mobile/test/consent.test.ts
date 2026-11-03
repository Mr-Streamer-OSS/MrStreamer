import { expect, it } from "vitest";
import { statisticsConsent, type ConsentRecord } from "../consent/statistics.ts";

it("starts unchosen and off for missing or unreadable storage", () => {
  for (const load of [
    () => null,
    () => {
      throw new Error("unreadable");
    },
  ]) {
    const consent = statisticsConsent({ load, save: () => true });
    expect(consent.get().choice).toBeNull();
    expect(consent.enabled).toBe(false);
  }
});

it("refused opt-in is off; Off and last-provider removal discard identity and outbox", () => {
  const saved: ConsentRecord<string> = {
    choice: "on",
    installationId: "random",
    pending: ["unsent"],
  };

  let held = saved;
  let writable = true;

  const consent = statisticsConsent({
    load: () => held,
    save: (next) => {
      if (writable) held = next;

      return writable;
    },
  });

  expect(consent.configure(false)).toBe(true);
  expect(held).toEqual({ choice: "off", installationId: null, pending: [] });
  consent.configure(true);
  consent.replace(saved);
  expect(consent.discard()).toBe(true);
  expect(held).toEqual({ choice: "on", installationId: null, pending: [] });
  writable = false;
  expect(consent.configure(true)).toBe(false);
  expect(consent.enabled).toBe(false);
});
