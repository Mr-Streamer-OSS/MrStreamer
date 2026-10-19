// Saved delays through Settings and actual media-ended events in an isolated built app.
import type { Preferences } from "../../../../packages/contracts/src/preferences.ts";
import type { Driver } from "./language.ts";

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const DELAY = `document.querySelector('input[aria-label="Next episode delay"]')`;
const AUTOPLAY = `document.querySelector('[role=checkbox][aria-label="Next episode"]')`;
const expect = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

export async function nextEpisodeScenario(
  d: Driver,
  files: () => { requests: number; mostAtOnce: number },
): Promise<void> {
  const preferences = () =>
    d.evaluate<Preferences>(`(async () => {
      const reply = await window.mrStreamer.invoke('preferences.get');
      if (!reply.ok) throw new Error('Preferences read failed');
      return reply.value;
    })()`);
  const endText = () => d.evaluate<string>("document.body.innerText");
  const remaining = async () => /Plays in (\d+)/.exec(await endText())?.[1] ?? null;
  const openSettings = async () => {
    d.action("Open Settings with the application shortcut");
    const modifiers = process.platform === "darwin" ? 8 : 2;
    await d.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: ",",
      windowsVirtualKeyCode: 188,
      modifiers,
    });
    await d.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: ",",
      windowsVirtualKeyCode: 188,
      modifiers,
    });
    await d.wait(() => d.exists(DELAY));
  };
  const setDelay = async (seconds: number) => {
    await d.click(`Edit the delay to ${seconds}`, DELAY);
    // Select the field text through the native editing shortcut.
    await d.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers: process.platform === "darwin" ? 8 : 2,
    });
    await d.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers: process.platform === "darwin" ? 8 : 2,
    });
    await d.send("Input.insertText", { text: String(seconds) });
    await d.key("Enter", 13);
    await d.wait(async () => (await preferences()).nextEpisodeDelay === seconds);
  };
  const closeSettings = async () => {
    await d.key("Escape", 27);
    await d.wait(async () => !(await d.exists(DELAY)));
  };
  const playEpisode = async (episode: string) => {
    await d.click("Open Series", named("header button", "Series"));
    await d.click("Open All series", named("nav button", "All series"));
    await d.click(
      "Open Formats details",
      `[...document.querySelectorAll('button[title]')].find(e => e.title.includes('Formats'))`,
    );
    const season = Number(/^S(\d+)/.exec(episode)?.[1]);
    await d.click(`Open season ${season}`, named("[role=dialog] button", `Season ${season}`));
    await d.click(
      `Play ${episode}`,
      `document.querySelector('[aria-label="More for ${episode}"]')?.closest('.group')?.querySelector('button')`,
    );
    await d.wait(() =>
      d.evaluate<boolean>(`(() => {
      const video = document.querySelector('video');
      return video?.videoWidth > 0 && video.currentTime > 0 &&
        document.querySelector('[data-view=title]')?.innerText.includes(${JSON.stringify(episode)});
    })()`),
    );
  };
  const seekEnd = async () => {
    await d.click(
      "Focus the Position scrubber",
      "document.querySelector('[role=slider][aria-label=Position]')",
    );
    await d.key("End", 35);
  };
  const waitEnded = (episode: string) =>
    d.wait(async () => (await endText()).includes(`Finished ${episode}`));
  const waitNext = (episode: string) =>
    d.wait(() =>
      d.evaluate<boolean>(
        `document.querySelector('[data-view=title]')?.innerText.includes(${JSON.stringify(episode)}) && !document.body.innerText.includes('Finished')`,
      ),
    );

  await openSettings();
  await setDelay(0);
  await d.capture("instant-settings");
  await closeSettings();
  await playEpisode("S1 E1");
  await seekEnd();
  await openSettings();
  await waitEnded("S1 E1");
  const instantFiles = files();
  // The real video ended behind Settings. Its next episode must wait for release.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(files().requests === instantFiles.requests, "Instant opened behind Settings");
  expect((await endText()).includes("Next episode"), "Held Instant has no Next episode action");
  expect(!(await endText()).includes("Plays in 0"), "Held Instant displays a zero countdown");
  await d.capture("instant-held");
  const releasedAt = Date.now();
  await closeSettings();
  await waitNext("S1 E2");
  d.observed["instant"] = {
    releaseToNextUiMs: Date.now() - releasedAt,
    before: instantFiles,
    after: files(),
  };
  await d.capture("instant-next");
  await d.key("Escape", 27);

  await openSettings();
  await setDelay(37);
  await closeSettings();
  await playEpisode("S1 E2");
  await seekEnd();
  await waitEnded("S1 E2");
  await d.wait(async () => (await remaining()) !== null);
  const customInitial = Number(await remaining());
  expect(customInitial <= 37 && customInitial >= 35, "Custom delay is not 37 seconds");
  await d.capture("custom-37-countdown");
  await openSettings();
  const held = await remaining();
  await setDelay(60);
  await d.click("Turn autoplay off while held", AUTOPLAY);
  await d.wait(async () => (await preferences()).autoplayNext === false);
  await d.click("Turn autoplay back on while held", AUTOPLAY);
  await d.wait(async () => (await preferences()).autoplayNext === true);
  expect((await remaining()) === held, "Settings changed the saved remaining seconds");
  await d.capture("custom-held-edited-to-60");
  await closeSettings();
  expect((await remaining()) === held, "Release replaced the saved delay");
  await d.wait(async () => Number(await remaining()) < Number(held));
  await d.click("Cancel the countdown", named("button", "Cancel"));
  const cancelledFiles = files();
  await openSettings();
  await closeSettings();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect((await remaining()) === null, "Cancelled countdown restarted");
  expect(files().requests === cancelledFiles.requests, "Cancel opened the next file");
  await d.capture("custom-cancelled");
  await d.key("n", 78);
  await waitNext("S1 E3");
  d.observed["custom37"] = {
    initial: customInitial,
    held,
    cancelledFiles,
    manualNextFiles: files(),
  };
  await d.key("Escape", 27);

  await playEpisode("S2 E1");
  await seekEnd();
  await waitEnded("S2 E1");
  await d.wait(async () => (await remaining()) !== null);
  const maximumInitial = Number(await remaining());
  expect(maximumInitial <= 60 && maximumInitial >= 58, "The next countdown did not use 60 seconds");
  await d.capture("maximum-60-countdown");
  await openSettings();
  await d.click("Turn autoplay off for final release", AUTOPLAY);
  await d.wait(async () => (await preferences()).autoplayNext === false);
  await closeSettings();
  await d.wait(async () => (await remaining()) === null);
  const offFiles = files();
  await openSettings();
  await d.click("Enable autoplay after cancellation", AUTOPLAY);
  await d.wait(async () => (await preferences()).autoplayNext === true);
  await closeSettings();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect((await remaining()) === null, "Final Off cancellation restarted after On");
  expect(files().requests === offFiles.requests, "Final Off opened another file");
  await d.capture("maximum-final-off");
  d.observed["maximum60"] = {
    initial: maximumInitial,
    finalOffFiles: offFiles,
    afterOnFiles: files(),
  };
  d.observed["limits"] =
    "Linux fake-provider UI proof. Native receivers, audible output and installed acceptance are separate. Session ordering and exact timings use the focused public controller tests; file requests include probing and ranges.";
}
