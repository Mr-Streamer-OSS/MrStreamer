// A title's seek step, typed jump and sleep timer in the real built window (Paper A8). Settings >
// Playback saves a 30-second seek step through its select; a movie's skip buttons then name it and
// Right moves it 30 seconds; the time before the scrubber takes "0:05" and goes there; the sleep
// timer's menu sets one minute, the button names when it pauses, and a minute later the movie is
// paused with the note said and the button off. Observations are decoded media, saved preferences
// and the visible controls.
import type { Preferences } from "../../../../packages/contracts/src/preferences.ts";
import type { Driver } from "./language.ts";

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;

const query = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;

const expect = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const SEEK_STEP = query('select[aria-label="Seek step"]');
const SLEEP = query('[data-view=title] button[aria-label="Sleep timer"]');
const GO_TO = 'input[aria-label="Go to time"]';

export async function titleControlsScenario(d: Driver): Promise<void> {
  const preferences = () =>
    d.evaluate<Preferences>(`(async () => {
      const reply = await window.mrStreamer.invoke('preferences.get');
      if (!reply.ok) throw new Error('Preferences read failed');
      return reply.value.preferences;
    })()`);

  const media = () =>
    d.evaluate<{ position: number; paused: boolean; frames: number }>(`(() => {
      const video = document.querySelector('video');
      return { position: video.currentTime, paused: video.paused,
        frames: video.getVideoPlaybackQuality().totalVideoFrames };
    })()`);

  // Controls fade without input; a pointer move brings them back, as it does for a viewer.
  const wake = () =>
    d.evaluate(
      "document.querySelector('[data-view=title]').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
    );

  // Settings > Playback > Seek step: 30 seconds, by the select's own type-ahead.
  await d.click("Open Settings", query("header button[aria-label=Settings]"));
  await d.click("Open Playback settings", named("nav button", "Playback"));
  await d.wait(() => d.evaluate<boolean>(`!!${SEEK_STEP} && !${SEEK_STEP}.disabled`));
  d.action("Pick 30 seconds in Seek step");
  await d.evaluate(`${SEEK_STEP}.focus()`);
  await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: "3", text: "3" });
  await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: "3" });
  await d.wait(async () => (await preferences()).seekStepSeconds === 30);
  await d.wait(() => d.evaluate<boolean>(`${SEEK_STEP}.value === "30"`));
  d.observed["seek-step-select"] = await d.evaluate(
    `[${SEEK_STEP}.value, [...${SEEK_STEP}.options].map(o => o.textContent)]`,
  );
  await d.capture("settings-seek-step");
  await d.click("Close Settings", named('[data-view="settings"] header button', "Back"));
  await d.wait(async () => !(await d.exists(SEEK_STEP)));

  // A movie plays, its skip buttons name the step, and Right moves it.
  await d.click("Open Movies", named("header button", "Movies"));
  await d.click("Open All movies", named("nav button", "All movies"));
  await d.click(
    "Open the long-subtitles movie",
    `[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Long subtitles'))`,
  );
  await d.click(
    "Play the movie",
    `[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim().startsWith('Play'))`,
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=title]') && document.querySelector('video')?.currentTime > 0.5",
    ),
  );
  await wake();

  const skips = await d.evaluate<string[]>(
    `[...document.querySelectorAll('[data-view=title] button[aria-label$=" seconds"]')].map(b => b.getAttribute('aria-label'))`,
  );

  d.observed["skip-buttons"] = skips;
  expect(
    skips.includes("Back 30 seconds") && skips.includes("Forward 30 seconds"),
    "The skip buttons don't name the saved step",
  );
  const before = await media();
  await d.key("ArrowRight", 39);
  await d.wait(async () => (await media()).position >= before.position + 28);
  d.observed["right"] = { before, after: await media() };

  // The time before the scrubber takes 0:05.
  await wake();
  await d.click("Open Go to time", query('[data-view=title] button[aria-label^="Go to time "]'));
  await d.wait(() => d.evaluate<boolean>(`document.activeElement?.matches('${GO_TO}') ?? false`));
  await d.send("Input.insertText", { text: "0:05" });
  await d.capture("go-to-time-field");
  await d.key("Enter", 13);
  await d.wait(async () => {
    const { position } = await media();

    return position >= 5 && position < 9;
  });
  d.observed["go-to-time"] = await media();
  expect(!(await d.exists(query(GO_TO))), "The field stayed open after Enter");

  // The sleep timer: one minute, named on its button, then paused.
  await wake();
  await d.click("Open the sleep timer", SLEEP);
  await d.wait(() => d.exists(query('[role=dialog][aria-label="Sleep timer"]')));
  d.observed["sleep-rows"] = await d.evaluate(
    "[...document.querySelectorAll('[role=dialog] [data-item]')].map(e => e.textContent)",
  );
  await d.capture("sleep-menu");
  await d.click("Choose 1 min", named("[role=dialog] [data-item]", "1 min"));

  const state = () =>
    d.evaluate<{ pressed: string | null; text: string | null; at: number; note: boolean }>(`({
      pressed: ${SLEEP}?.getAttribute('aria-pressed') ?? null,
      text: ${SLEEP}?.textContent ?? null,
      at: Date.now(),
      note: document.body.innerText.includes('Sleep timer paused playback'),
    })`);

  const set = await state();
  d.observed["sleep-set"] = set;
  expect(set.pressed === "true" && /\d/.test(set.text ?? ""), "The sleep button names no time");
  await wake();
  await d.capture("sleep-set");
  await d.wait(async () => (await media()).paused, 90_000);
  const fired = await state();
  d.observed["sleep-fired"] = { ...fired, media: await media(), afterMs: fired.at - set.at };
  expect(fired.at - set.at >= 59_000, "The movie paused before its minute ran out");
  expect(fired.note, "No note said the sleep timer paused playback");
  await wake();
  await d.capture("sleep-fired");
  expect(fired.pressed === "false", "The sleep button stayed on after it fired");
}
