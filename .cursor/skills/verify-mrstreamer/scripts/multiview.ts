import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type as arkType } from "arktype";
import { MultiviewLayout } from "../../../../packages/contracts/src/preferences.ts";
import type { Driver } from "./language.ts";

const named = (text: string, scope = "document") =>
  `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;

const labelled = (label: string) =>
  `document.querySelector('button[aria-label=${JSON.stringify(label)}]')`;

const group = "document.querySelector('[role=group][aria-label=Multiview]')";

const pane = (name: string) =>
  `${group}?.querySelector('[role=group][aria-label=${JSON.stringify(name)}]')`;

const timeline = "document.querySelector('[data-live-timeline] input')";
const first = "H.264 + AAC";
const second = "H.264 + MP2";
const third = "H.264 + MP3";

/**
 * Real window journey: adoption, independent panes, capacity refusal, saved IDs on restart, and
 * Single view followed at once by the next channel, played, paused and stopped.
 */
export async function multiviewScenario(
  d: Driver,
  streams: () => { requests: number; active: number },
) {
  const check = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message);
  };

  d.observed["multiviewLimits"] = [
    "Linux Xvfb development build with two synthetic streams; no native four-pane/resource qualification",
    "Video muted/volume properties prove routing, not audible sound or physical receiver behavior",
    "No installed, security, full council or main integration acceptance",
    "Single view then ArrowDown is one ordinary run: input order shows neither when main committed Single nor when the renderer took its answer, so it covers the outcome reached, not their overlap",
  ];

  // Only DOM and native video properties; never the player/store or IPC.
  const picture = (scope = "document") =>
    d.evaluate<{
      time: number;
      frames: number;
      paused: boolean;
      poster: string;
      width: number;
      identity: number;
    }>(`(async () => {
      const v = ${scope}?.querySelector('video');
      if (!v) return {time:0,frames:0,paused:true,poster:'',width:0,identity:0};
      // A paused decoder releases native dimensions; its displayed JPEG must decode as a picture.
      let source = v;
      if (v.paused && v.poster) {
        const poster = new Image(); poster.src = v.poster;
        await poster.decode(); source = poster;
      }
      const width = source === v ? v.videoWidth : source.naturalWidth;
      const c = document.createElement('canvas'); c.width=640; c.height=360;
      const ctx = c.getContext('2d'); let identity=0;
      if(width) { ctx.drawImage(source,0,0,640,360);
        for(let bit=0;bit<12;bit++) if(ctx.getImageData(bit*32+16,16,1,1).data[0]>180) identity+=2**bit;
      }
      return {time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,paused:v.paused,
        poster:v.poster,width,identity};
    })()`);

  const advancing = async (name: string, scope = "document") => {
    const before = await picture(scope);
    await d.wait(async () => {
      const after = await picture(scope);

      return (
        after.width > 0 &&
        !after.paused &&
        after.frames > before.frames &&
        after.time > before.time + 1 &&
        after.identity > before.identity
      );
    }, 60_000);
    const { poster: _poster, ...facts } = await picture(scope);
    d.observed[name] = { ...facts, streams: streams() };
  };

  const open = async (stage: string) => {
    await d.click("Open Search", labelled("Search"));
    await d.send("Input.insertText", { text: first });
    await d.wait(() =>
      d.exists("document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')"),
    );
    await d.key("Enter", 13);
    await d.wait(() => d.exists(timeline));
    await advancing(stage);
  };

  const enter = async () => {
    await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 500 });
    await d.click("Open More", labelled("More"));
    await d.click("Enter Multiview", named("Multiview"));
    await d.wait(() => d.exists(group));
  };

  const add = async (name: string) => {
    await d.click("Add channel", named("Add channel", group));
    await d.click(
      "Search channels",
      "document.querySelector('input[aria-label=\"Search channels\"]')",
    );
    await d.send("Input.insertText", { text: name });
    await d.click(
      `Pick ${name}`,
      `[...document.querySelectorAll('button[data-item]')].find(b => b.textContent.includes(${JSON.stringify(name)}))`,
    );
  };

  const layouts = async () =>
    arkType({ multiviewLayouts: MultiviewLayout().array() }).assert(
      JSON.parse(await readFile(join(d.profile, "preferences.json"), "utf8")),
    ).multiviewLayouts;

  await open("initial-single");
  // Wait for real retained history visible in the scrubber, then rewind and pause through controls.
  await d.wait(() => d.evaluate<boolean>(`${timeline}.max - ${timeline}.min > 20000`), 90_000);
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 500 });
  await d.click("Rewind selected channel", labelled("Back 10 seconds"));
  await advancing("rewound-playing");
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 301, y: 500 });
  await d.click("Pause selected channel", labelled("Pause"));
  await d.wait(() => d.exists(labelled("Play")));
  const paused = await picture();
  const cursor = await d.evaluate<number>(`${timeline}.value * 1`);
  check(paused.poster.startsWith("data:image/jpeg"), "Paused rewind has no retained picture");
  const adoptedRequests = streams().requests;
  await enter();
  const adopted = await picture(pane(first));
  d.observed["adoption"] = {
    paused: adopted.paused,
    width: adopted.width,
    samePoster: adopted.poster === paused.poster,
    cursor,
    requests: streams().requests,
  };
  check(
    adopted.poster === paused.poster && adopted.paused,
    "Entering multiview lost paused picture",
  );
  check(
    await d.evaluate<boolean>(`${timeline}.value * 1 === ${cursor}`),
    "Entering multiview lost rewind cursor",
  );
  check(streams().requests === adoptedRequests, "Adoption opened a new upstream");
  await d.capture("adopted-paused-rewind");
  await d.click("Resume first pane", labelled("Play"));
  await add(second);
  await advancing("first-pane-advancing", pane(first));
  await advancing("second-pane-advancing", pane(second));
  const requests = streams().requests;
  check(streams().active === 2, "Expected two upstream captures");
  await d.click("Select second pane", `${pane(second)}.querySelector('[data-select]')`);
  await d.wait(() =>
    d.evaluate<boolean>(`${pane(second)}.getAttribute('aria-current') === 'true'`),
  );
  check(
    await d.evaluate<boolean>(`(() => {
    const all=[...${group}.querySelectorAll('video')];
    return all.filter(v=>!v.muted && v.volume>0).length === 1 && !${pane(second)}.querySelector('video').muted;
  })()`),
    "Selected pane is not the sole audible element",
  );
  await d.capture("two-panes-selected");
  await add(third);
  await d.wait(() =>
    d.evaluate<boolean>(`${pane(third)}?.textContent.includes('No stream free') ?? false`),
  );
  check(
    streams().requests === requests && streams().active === 2,
    "Refusal changed upstream captures",
  );
  await advancing("survives-refusal", pane(second));
  await d.capture("capacity-refusal");
  await d.click("Close refused pane", labelled(`Close ${third}`));
  await d.wait(() => d.evaluate<boolean>(`!${pane(third)}`));
  await d.click("Save layout", named("Save layout"));
  await d.click("Layout name", "document.querySelector('#multiview-layout-name')");
  await d.send("Input.insertText", { text: "Fixture pair" });
  await d.click("Save named layout", named("Save"));
  await d.wait(() => d.evaluate<boolean>("!document.querySelector('#multiview-layout-name')"));
  const saved = await layouts();
  check(
    saved.some((l) => l.name === "Fixture pair" && l.channels.length === 2),
    "Saved layout lacks channel IDs",
  );
  d.observed["savedLayouts"] = saved;
  await d.quit();
  await d.launch();
  check(
    JSON.stringify(await layouts()) === JSON.stringify(saved),
    "Layout IDs/name changed on restart",
  );
  await open("restarted-single");
  await enter();

  const layoutButton =
    "[...document.querySelectorAll('header button')].find(b => b.textContent.trim().startsWith('Layout'))";

  for (const [key, code] of [
    ["Enter", 13],
    [" ", 32],
  ] as const) {
    await d.evaluate(`${layoutButton}.focus()`);
    await d.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      windowsVirtualKeyCode: code,
      text: key === "Enter" ? "\r" : " ",
    });
    await d.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code });
    await d.wait(() =>
      d.evaluate<boolean>(`${layoutButton}.getAttribute('aria-expanded') === 'true'`),
    );
    check(
      !(await d.exists("document.querySelector('[role=button] > span[title]')")),
      "Layout key opened Channels",
    );
    await d.capture(key === "Enter" ? "layout-enter" : "layout-space");
    await d.click("Close Layout", layoutButton);
  }

  await d.click("Open Layout", layoutButton);
  await d.click(
    "Restore saved layout",
    `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Fixture pair') && b.textContent.includes('2 channels'))`,
  );
  await advancing("restored-second-pane", pane(second));
  await d.wait(() =>
    d.evaluate<boolean>(`${layoutButton}.closest('header').textContent.includes('2 of 2 streams')`),
  );
  d.observed["restoredCapacity"] = {
    text: await d.evaluate<string>(`${layoutButton}.closest('header').textContent`),
    streams: streams(),
  };
  await d.capture("restored-layout");
  await d.click("Close first pane independently", labelled(`Close ${first}`));
  await d.wait(() => d.evaluate<boolean>(`!${pane(first)}`));
  await advancing("survives-peer-close", pane(second));
  await d.click("Close final pane", labelled(`Close ${second}`));
  await d.wait(() => d.evaluate<boolean>(`!${group}`));
  await d.wait(async () => streams().active === 0);
  await d.capture("all-panes-closed");
  // A fresh UI visit after independent close checks keeps the continuity failure isolated.
  await open("after-close-single");
  await enter();
  await add(second);
  await advancing("second-before-single", pane(second));
  await d.click("Select second before Single", `${pane(second)}.querySelector('[data-select]')`);
  await d.wait(() => d.evaluate<boolean>(`${timeline}.max - ${timeline}.min > 20000`), 90_000);
  await d.click("Rewind second before Single", labelled("Back 10 seconds"));
  await advancing("second-rewound-before-single", pane(second));
  const singleRequests = streams().requests;
  await d.click("Pause second pane", labelled("Pause"));
  await d.wait(() => d.exists(labelled("Play")));
  const selected = await picture(pane(second));
  const singleCursor = await d.evaluate<number>(`${timeline}.value * 1`);
  check(selected.poster.startsWith("data:image/jpeg"), "Selected pane has no paused picture");
  d.observed["beforeSingle"] = {
    cursor: singleCursor,
    paused: selected.paused,
    hasPoster: selected.poster.startsWith("data:image/jpeg"),
    streams: streams(),
  };
  await d.click("Return Single view", named("Single view"));
  await d.wait(() => d.evaluate<boolean>(`!${group}`));
  await d.capture("single-return-state");
  d.observed["singleReturnDOM"] = await d.evaluate(`(() => ({
    text: document.body.innerText.slice(0, 2000),
    videos: [...document.querySelectorAll('video')].map(v => ({
      paused:v.paused, width:v.videoWidth, poster:v.poster.startsWith('data:image/jpeg'),
      visible:v.checkVisibility(), time:v.currentTime
    }))
  }))()`);
  d.observed["afterSingleStreams"] = streams();
  const single = await picture();
  check(
    single.width > 0 && single.paused && single.poster === selected.poster,
    "Single view lost selected paused picture",
  );
  check(
    await d.evaluate<boolean>(`${timeline}.value * 1 === ${singleCursor}`),
    "Single view lost rewind cursor",
  );
  await d.wait(async () => streams().active === 1);
  check(streams().requests === singleRequests, "Single view opened an upstream");
  d.observed["continuity"] = {
    adoptedRequests,
    requests: streams().requests,
    cursor,
    singleCursor,
    nonempty: true,
  };
  await d.capture("single-paused-continuity");

  // P04: Single view and, without waiting for it, the next channel, as a viewer pressing on.
  await enter();
  await d.click("Resume P04 selected pane", labelled("Play"));
  await add(first);
  await advancing("p04-peer-advancing", pane(first));
  await advancing("p04-selected-advancing", pane(second));
  check(streams().active === 2, "P04 expected two upstream captures");
  await d.click("Select P04 pane", `${pane(second)}.querySelector('[data-select]')`);
  await d.wait(() =>
    d.evaluate<boolean>(`${pane(second)}.getAttribute('aria-current') === 'true'`),
  );

  // Watch's Channels list, in its order, as ArrowDown walks it; closed again before returning.
  const rows =
    "[...document.querySelectorAll('[role=button]')].filter(r => r.querySelector(':scope > span[title]')).sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))";

  const channelList = async () => {
    await d.evaluate("document.querySelector('[data-view=watch]').focus()");
    await d.key("Enter", 13);
    await d.wait(() => d.evaluate<boolean>(`${rows}.length > 0`));

    const listed = await d.evaluate<{ name: string; playing: boolean }[]>(
      `${rows}.map(r => ({ name: r.querySelector(':scope > span[title]').title, playing: !!r.querySelector('[aria-label=Playing]') }))`,
    );

    await d.click("Close Channels", labelled("Close"));
    await d.wait(() => d.evaluate<boolean>(`${rows}.length === 0`));

    return listed;
  };

  const listed = await channelList();
  const at = listed.findIndex((r) => r.playing);
  const playing = listed[at];
  const next = listed[at + 1];

  if (
    !playing?.name.includes(second) ||
    !next ||
    next.name.includes(first) ||
    next.name.includes(second) ||
    listed.filter((r) => r.name === next.name).length !== 1
  )
    throw new Error("P04 inconclusive: no unique distinct channel follows the selected pane");
  const p04Requests = streams().requests;
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 302, y: 500 });
  await d.click("P04 Single view", named("Single view"));
  await d.key("ArrowDown", 40);
  await d.wait(() => d.evaluate<boolean>(`!${group}`));
  await advancing("p04-next-advancing");
  await d.wait(async () => streams().active === 1);
  check(streams().requests > p04Requests, "P04 next channel opened no upstream");
  const shown = (await channelList()).find((r) => r.playing)?.name;
  check(shown === next.name, "P04 plays another channel than the next one");
  await d.capture("p04-next-channel");
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 303, y: 500 });
  await d.click("Pause P04 channel", labelled("Pause"));
  await d.wait(() => d.exists(labelled("Play")));
  await d.click("Play P04 channel", labelled("Play"));
  await advancing("p04-next-resumed");
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 304, y: 500 });
  await d.click("Stop P04 channel", labelled("Stop"));
  await d.wait(async () => streams().active === 0);
  d.observed["p04"] = {
    selected: playing.name,
    next: next.name,
    shown,
    requests: streams().requests - p04Requests,
    streams: streams(),
    order: "sequential healthy outcome only",
  };
  await d.capture("p04-stopped");
}
