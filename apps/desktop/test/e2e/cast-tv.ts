// Plays on a stand-in Google Cast TV through a built app's real window, on this computer's own
// local network address: the one way to run the whole path without a TV. The app finds the TV by
// mDNS, connects to it, and the TV fetches what it is sent from the app, as a TV's player would.
//
//   node test/e2e/cast-tv.ts <app executable> [-- extra app arguments]
//   xvfb-run -a node test/e2e/cast-tv.ts node_modules/electron/dist/electron -- . --no-sandbox
//
// It plays a movie here, moves it to the TV from the chooser, pauses and skips it there, leaves
// the player, and brings it back with Play here; then moves a channel to the TV and quits. It
// passes when the TV was told each of those, fetched H.264 with AAC from the app's address, the
// provider never saw more than one connection, and quitting stopped the TV.
//
// The TV is the suite's fake Cast device (../fake-cast-receiver.ts), which holds the app to
// Chromium's schema, behind a TLS forwarder on the local network's address: its own certificate
// is hand-made for the suite, and Electron's TLS reads only a well-formed one, as a real device
// has. A few lines of mDNS answer the app's browse. It needs a private IPv4 address on an
// interface that isn't a tunnel (see src/main/playback/lan.ts), `openssl` for the certificate
// and `ffprobe`. docs/contributing/testing.md has a way to make such a network on a machine
// that has none. The app runs with MR_STREAMER_CAST=on, so Linux and macOS builds offer Cast too.
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, createServer as tlsServer } from "node:tls";
import dns from "dns-packet";
import { lanAddresses } from "../../src/main/playback/lan.ts";
import { startFakeCastReceiver } from "../fake-cast-receiver.ts";
import { fixture, startFakeProvider } from "../fake-provider.ts";
import { connect, delay, key, launch, login, waitFor, type Page } from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Usage: node test/e2e/cast-tv.ts <app executable> [-- args]");
const [lan] = lanAddresses();
if (!lan) throw new Error("This computer has no address on a local network for a TV to reach.");

const work = mkdtempSync(join(tmpdir(), "mr-streamer-cast-"));
const results: boolean[] = [];
function check(ok: boolean, what: string, detail = ""): void {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
}

// The TV: the fake device, reached on the local network's address and found by mDNS.
const tv = await startFakeCastReceiver();
tv.duration = null;
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=stand-in-tv",
  ].concat(["-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem")]),
  { stdio: "ignore" },
);
const forward = tlsServer(
  { key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) },
  (client) => {
    const device = tlsConnect({ port: tv.port, host: "127.0.0.1", rejectUnauthorized: false });
    client.pipe(device);
    device.pipe(client);
    for (const [one, other] of [
      [client, device],
      [device, client],
    ] as const) {
      one.on("error", () => other.destroy());
      one.on("close", () => other.destroy());
    }
  },
);
await new Promise<void>((resolve) => forward.listen(0, lan, resolve));
const castPort = (forward.address() as { port: number }).port;
const mdns = createSocket({ type: "udp4", reuseAddr: true });
await new Promise<void>((resolve) => mdns.bind(5353, resolve));
mdns.addMembership("224.0.0.251", lan);
mdns.on("message", (message, from) => {
  let id: number;
  try {
    const query = dns.decode(message);
    if (query.type !== "query") return;
    id = query.id ?? 0;
  } catch {
    return;
  }
  const service = "Stand-in-TV._googlecast._tcp.local";
  const host = "stand-in-tv.local";
  const answers: dns.Answer[] = [
    { type: "PTR", name: "_googlecast._tcp.local", ttl: 120, data: service },
    { type: "SRV", name: service, ttl: 120, data: { port: castPort, target: host } },
    // `ca` bit 0: it shows video.
    {
      type: "TXT",
      name: service,
      ttl: 120,
      data: [`id=${tv.receiver.id}`, "fn=Living Room TV", "ca=1"],
    },
    { type: "A", name: host, ttl: 120, data: lan },
  ];
  mdns.send(
    dns.encode({ type: "response", id, flags: dns.AUTHORITATIVE_ANSWER, answers }),
    from.port,
    from.address,
  );
});

/**
 * The TV's player: for the media it holds it reads the playlists, fetches the segment it is at
 * and the next, says it plays once it has them, and moves its position on while it does.
 */
const fetched = { segments: 0, refused: 0 };
let segment: Buffer | null = null;
const have = new Set<string>();
async function get(url: string): Promise<Buffer | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) }).catch(() => null);
  if (!response?.ok) fetched.refused++;
  return response?.ok ? Buffer.from(await response.arrayBuffer()) : null;
}
let busy = false;
const player = setInterval(() => {
  const media = tv.media;
  if (!media || busy) return;
  busy = true;
  void (async () => {
    const address = String(media.media["contentId"]);
    const first = (await get(address))?.toString() ?? "";
    // A title's playlist names its picture's; a channel's lists its segments itself.
    const named = first.split("\n").find((line) => line && !line.startsWith("#"));
    const list =
      first.includes("#EXTINF") || !named ? address : new URL(named.trim(), address).href;
    const text = list === address ? first : ((await get(list))?.toString() ?? "");
    let start = 0;
    let length = 0;
    const segments: { start: number; length: number; url: string }[] = [];
    for (const line of text.split("\n")) {
      const info = /^#EXTINF:([\d.]+)/.exec(line);
      if (info) length = Number(info[1]);
      else if (line && !line.startsWith("#")) {
        segments.push({ start, length, url: new URL(line.trim(), list).href });
        start += length;
      }
    }
    const live = media.media["streamType"] === "LIVE";
    if (!live) media.media = { ...media.media, duration: start };
    const at = media.currentTime;
    const wanted = live
      ? segments.slice(-2)
      : segments.filter((each) => each.start + each.length > at && each.start < at + 6).slice(0, 2);
    for (const each of wanted) {
      if (have.has(each.url)) continue;
      const bytes = await get(each.url);
      if (!bytes) continue;
      have.add(each.url);
      fetched.segments++;
      segment = bytes;
    }
    if (tv.media !== media || wanted.length === 0 || !wanted.every((each) => have.has(each.url))) {
      return;
    }
    if (media.playerState === "BUFFERING") tv.status({ playerState: "PLAYING" });
    else if (media.playerState === "PLAYING" && !live) media.currentTime += 0.5;
  })().finally(() => (busy = false));
}, 500);

// The app, with a provider whose channels send a forty-second recording over forty seconds and
// stay open, as a live one does: a receiver's stream needs more than the three-second clips.
const recording = fixture("recording-long-subtitles.mpegts");
const provider = await startFakeProvider({
  channels: 60,
  streams: (_channel, out, signal) => {
    const step = Math.ceil(recording.length / 400 / 188) * 188;
    let offset = 0;
    const timer = setInterval(() => {
      out.write(recording.subarray(offset, offset + step));
      offset += step;
      if (offset >= recording.length) clearInterval(timer);
    }, 100);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  },
});
const port = 20000 + Math.floor(Math.random() * 20000);
const profile = join(work, "profile");
process.env["MR_STREAMER_CAST"] = "on";
const app = launch(executable, rest, { port, profile });

const text = (page: Page, selector = "body") =>
  page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
const says = (page: Page, words: string, selector?: string) => async () =>
  (await text(page, selector)).includes(words);
/** Clicks the button whose text starts with `label`, or that has it as its label, once there is one. */
async function press(page: Page, label: string): Promise<void> {
  const button = `[...document.querySelectorAll("button")].find((b) =>
    b.textContent.trim().startsWith(${JSON.stringify(label)}) ||
    b.getAttribute("aria-label") === ${JSON.stringify(label)})`;
  await waitFor(() => page.evaluate<boolean>(`!!${button}`), 20_000);
  await page.evaluate(`${button}.click()`);
}
const output = async (page: Page) =>
  (
    await page.evaluate<{
      value?: { output: { kind: string; media?: { state: string; position: number } | null } };
    }>(`window.mrStreamer.invoke("output.status")`)
  ).value?.output;
const clock = (page: Page) =>
  page.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`);
/** Opens the chooser and picks the TV. */
async function choose(page: Page): Promise<void> {
  await key(page, "o", 79);
  await press(page, "Living Room TV");
}

let broke = false;
try {
  const page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);

  // A movie plays here.
  await press(page, "Movies");
  const tab = `[...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "All movies")`;
  await waitFor(() => page.evaluate<boolean>(`!!${tab}`), 60_000);
  await page.evaluate(`${tab}.click()`);
  const poster = `[...document.querySelectorAll("button[title]")].find((b) => b.title.includes("Two sound tracks"))`;
  await waitFor(() => page.evaluate<boolean>(`!!${poster}`), 60_000);
  await page.evaluate(`${poster}.click()`);
  await waitFor(says(page, "Play", '[role="dialog"]'), 20_000);
  await press(page, "Play");
  await waitFor(async () => (await clock(page)) > 2, 30_000);
  const here = await clock(page);

  // A TV that won't start the app: the viewer is told, and the movie plays on here.
  tv.answers.launch = "refuse";
  await choose(page);
  await waitFor(says(page, "Living Room TV isn't available"), 15_000);
  check(
    (await output(page))?.kind === "local",
    "A TV that refuses leaves the movie here, and says so",
  );
  tv.answers.launch = "start";
  await key(page, "Escape", 27);

  // It moves to the TV from where it was, and the chooser closes.
  await choose(page);
  await waitFor(says(page, "Playing on Living Room TV", "[data-view=title]"), 40_000);
  const moved = await output(page);
  check(
    moved?.media?.state === "playing" && Math.abs(moved.media.position - here) < 8,
    "The movie moves to the TV from where it was",
    `${here.toFixed(1)} s here, ${moved?.media?.position.toFixed(1)} s there`,
  );
  await key(page, " ", 32);
  await waitFor(says(page, "Paused on Living Room TV", "[data-view=title]"), 10_000);
  check(tv.media?.playerState === "PAUSED", "Space pauses the TV");
  await key(page, " ", 32);
  await waitFor(says(page, "Playing on Living Room TV", "[data-view=title]"), 10_000);
  const before = tv.media?.currentTime ?? 0;
  await key(page, "ArrowRight", 39);
  await waitFor(async () => tv.requests("SEEK").length > 0, 10_000);
  const skipped = Number(tv.requests("SEEK").at(-1)?.["currentTime"]);
  check(
    Math.abs(skipped - before - 10) < 3,
    "Right skips the TV ten seconds",
    `${before.toFixed(1)} s to ${skipped.toFixed(1)} s`,
  );

  // Back leaves it playing, with the bar at the foot of the pages and no preview.
  await key(page, "Escape", 27);
  await delay(600);
  await key(page, "Escape", 27);
  const bar = '[role="region"][aria-label^="Playing"]';
  await waitFor(says(page, "Play here", bar), 10_000);
  await press(page, "Home");
  await waitFor(says(page, "Preview waits while Living Room TV plays"), 10_000);
  check(tv.media?.playerState === "PLAYING", "Back leaves the TV playing, and the bar says where");
  check(
    provider.activeStreams() <= 1,
    "No preview takes a connection",
    `${provider.activeStreams()} open`,
  );

  // Play here brings it back from where the TV was.
  const there = tv.media?.currentTime ?? 0;
  await press(page, "Play here");
  await waitFor(async () => (await output(page))?.kind === "local", 15_000);
  await waitFor(async () => (await clock(page)) > 0.5, 30_000);
  const back = await clock(page);
  check(
    Math.abs(back - there) < 8 && tv.app === null,
    "Play here stops the TV and carries on here",
    `${there.toFixed(1)} s there, ${back.toFixed(1)} s here`,
  );
  if (segment) {
    writeFileSync(join(work, "segment.ts"), segment);
    const codecs = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0"].concat(
        join(work, "segment.ts"),
      ),
    ).toString();
    check(
      /h264/.test(codecs) && /aac/.test(codecs),
      "The TV fetched H.264 with AAC",
      `${fetched.segments} segments`,
    );
  } else check(false, "The TV fetched nothing");
  await key(page, "Escape", 27);
  await delay(800);

  // A channel moves to the TV too.
  await press(page, "Search");
  await delay(500);
  await page.send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await delay(800);
  await key(page, "Enter", 13);
  await waitFor(async () => (await clock(page)) > 1, 30_000);
  const title = fetched.segments;
  await choose(page);
  await waitFor(says(page, "Playing on Living Room TV", "[data-view=watch]"), 40_000);
  await delay(3000);
  check(
    fetched.segments > title && provider.activeStreams() === 1,
    "A channel moves to the TV on the one connection",
    `${fetched.segments - title} segments, ${provider.activeStreams()} open`,
  );

  // Quitting ends it.
  page.close();
  app.kill("SIGTERM");
  await waitFor(async () => tv.app === null && provider.activeStreams() === 0, 10_000).catch(
    () => {},
  );
  check(
    tv.app === null && provider.activeStreams() === 0,
    "Quitting stops the TV and frees the provider",
  );
  check(
    fetched.refused === 0,
    "The app answered every request of the TV",
    `${fetched.refused} refused`,
  );
  check(
    tv.violations.length === 0,
    "Every message fits Chromium's schema",
    `${tv.received.length} sent`,
  );
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  broke = true;
} finally {
  clearInterval(player);
  app.kill("SIGKILL");
  mdns.close();
  forward.close();
  await tv.close();
  await provider.close();
  await delay(1000);
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(broke || results.includes(false) ? 1 : 0);
