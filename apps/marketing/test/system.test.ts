import { describe, expect, it } from "vitest";
import { systemOf, type System, type SystemHints } from "../src/system.ts";

// The home page runs systemOf from its own text, in a script in the head (vite.config.ts). So do
// these tests: a function that needed anything outside itself would fail here as it would there.
const inPage: typeof systemOf = new Function(`return (${systemOf})`)();

const CHROME = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const LINUX_CHROME = `Mozilla/5.0 (X11; Linux x86_64) ${CHROME}`;
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

/** A visitor's browser: a user agent, and what Chromium adds to it. */
const visitor = (
  userAgent: string,
  platform?: string,
  rest: Partial<SystemHints> = {},
): SystemHints => ({
  userAgent,
  maxTouchPoints: 0,
  ...(platform !== undefined && { userAgentData: { platform, mobile: false } }),
  ...rest,
});

const desktops: [string, System, SystemHints][] = [
  [
    "Chrome on Windows",
    "windows",
    visitor(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`, "Windows"),
  ],
  [
    "Firefox on Windows",
    "windows",
    visitor("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0"),
  ],
  // A Windows laptop with a touch screen is still a computer.
  [
    "Edge on a touch laptop",
    "windows",
    visitor(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME} Edg/141.0.0.0`, "Windows", {
      maxTouchPoints: 10,
    }),
  ],
  ["Safari on a Mac", "mac", visitor(MAC_SAFARI)],
  [
    "Chrome on a Mac",
    "mac",
    visitor(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`, "macOS"),
  ],
  ["Chrome on Linux", "linux", visitor(LINUX_CHROME, "Linux")],
  [
    "Firefox on Ubuntu",
    "linux",
    visitor("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"),
  ],
  [
    "a browser that says Wayland",
    "linux",
    visitor(`Mozilla/5.0 (Wayland; Linux x86_64) ${CHROME}`),
  ],
];

const others: [string, SystemHints][] = [
  [
    "Chrome on an Android phone",
    visitor(
      `Mozilla/5.0 (Linux; Android 10; K) ${CHROME.replace("Safari", "Mobile Safari")}`,
      "Android",
      {
        userAgentData: { platform: "Android", mobile: true },
      },
    ),
  ],
  // No "Mobile" in a tablet's user agent, and Firefox sends no platform.
  ["an Android tablet", visitor(`Mozilla/5.0 (Linux; Android 14; SM-X710) ${CHROME}`)],
  [
    "Firefox on Android",
    visitor("Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0"),
  ],
  [
    "Safari on an iPhone",
    visitor(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      undefined,
      { maxTouchPoints: 5 },
    ),
  ],
  [
    "Safari on an iPad",
    visitor(
      "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      undefined,
      { maxTouchPoints: 5 },
    ),
  ],
  // The desktop site on an iPad: a Mac's user agent, and a touch screen no Mac has.
  ["an iPad asking for the desktop site", visitor(MAC_SAFARI, undefined, { maxTouchPoints: 5 })],
  ["ChromeOS", visitor(`Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) ${CHROME}`, "Chrome OS")],
  // The platform a browser names counts, even when its user agent reads as a desktop's.
  ["a desktop user agent on ChromeOS", visitor(LINUX_CHROME, "Chrome OS")],
  ["a desktop user agent on Android", visitor(LINUX_CHROME, "Android")],
  ["a platform and user agent that disagree", visitor(LINUX_CHROME, "Windows")],
  // X11 without Linux is some other Unix.
  [
    "Firefox on FreeBSD",
    visitor("Mozilla/5.0 (X11; FreeBSD amd64; rv:143.0) Gecko/20100101 Firefox/143.0"),
  ],
  // Linux without a desktop's X11 or Wayland is a television or an appliance.
  ["a Tizen television", visitor(`Mozilla/5.0 (SMART-TV; LINUX; Tizen 8.0) ${CHROME}`)],
  ["a webOS television", visitor(`Mozilla/5.0 (Web0S; Linux/SmartTV) ${CHROME}`, "Linux")],
  [
    "an Xbox",
    visitor(`Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One) ${CHROME} Edg/141.0.0.0`),
  ],
  ["no user agent at all", visitor("")],
];

describe("the hero's one download button", () => {
  it.each(desktops)("is the visitor's own for %s", (_, system, hints) => {
    expect(inPage(hints)).toBe(system);
  });

  it.each(others)("stays on Downloads for %s", (_, hints) => {
    expect(inPage(hints)).toBeUndefined();
  });
});
