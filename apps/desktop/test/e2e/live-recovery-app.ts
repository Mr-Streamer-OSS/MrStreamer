// Checks in a built app what a live channel does when its stream fails, against the fake provider:
// what the suite can't, because the real player, the real proxy and a provider that counts its
// connections only meet here. The provider allows one connection, so a second stream opened while
// one is open would be refused and show. It checks, in order:
//
// - Automatic passes a quality the provider has no stream for and plays the next, and the quality
//   menu says what became of each: the provider's status on the one, Playing on the other.
// - A channel without a stream says so with the provider's status and offers Retry, Next channel
//   and Channels. R asks the provider once more, and nothing asks again by itself.
// - With the connection held elsewhere, the channel says the provider refused, with its status,
//   after the proxy's two short retries and no more. It offers no other quality and isn't tried
//   again by itself. Once the connection is free, R plays it.
// - A stream that comes back for a few seconds and ends again is sent five times in all, four
//   reconnects, never two at once. Then the channel says it keeps dropping and no more is sent.
// - A picture that stands still says Waiting for data, then the channel reconnects. Stop during
//   the wait for a reconnect ends it: no stream is opened after it.
//
//   node test/e2e/live-recovery-app.ts <app executable> [-- extra app arguments]
//
// The app runs with a throwaway profile and remote debugging on a random port; on macOS pass
// --use-mock-keychain so the test never touches a real keychain. It takes about two minutes, most
// of it the waits being checked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, startFakeProvider, type FakeProviderOptions } from "../fake-provider.ts";
import { connect, delay, key, launch, login, says, waitFor, type Page } from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) {
  throw new Error("Usage: node test/e2e/live-recovery-app.ts <app executable> [-- args]");
}

/** Where Watch says what a channel does when it shows no picture, and offers what can help. */
const BLOCK = "[data-playback-state]";

/**
 * What the provider does with a stream once it sent the three seconds it has: `hold` keeps the
 * connection open without data, as a channel that stalls; `end` closes it three seconds later, as
 * a provider that drops a stream; `nothing` closes it before sending anything.
 */
let after: "hold" | "end" | "nothing" = "hold";
let open = 0;
let mostOpen = 0;
/** How many streams the provider began to send. A request it refused or answered 404 isn't one. */
let sent = 0;
const clip = fixture("h264-aac.mpegts");
const streams: NonNullable<FakeProviderOptions["streams"]> = (_channel, out, signal) => {
  if (after === "nothing") return void out.destroy();
  const ending = after;
  sent++;
  mostOpen = Math.max(mostOpen, ++open);
  const step = Math.ceil(clip.length / 30);
  let offset = 0;
  let closing: ReturnType<typeof setTimeout> | undefined;
  const timer = setInterval(() => {
    out.write(clip.subarray(offset, offset + step));
    offset += step;
    if (offset < clip.length) return;
    clearInterval(timer);
    if (ending === "end") closing = setTimeout(() => out.end(), 3000);
  }, 100);
  signal.addEventListener(
    "abort",
    () => {
      open--;
      clearInterval(timer);
      clearTimeout(closing);
    },
    { once: true },
  );
};

const port = 20000 + Math.floor(Math.random() * 20000);
const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const provider = await startFakeProvider({ channels: 60, maxConnections: 1, streams });
const app = launch(executable, rest, { port, profile });

let failed = false;
/** Prints how a check went. */
function report(name: string, result: { ok: boolean; detail: string }): void {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${name}: ${result.detail}`);
  failed ||= !result.ok;
}

try {
  const page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);
  report("Automatic passes a missing quality and the menu says so", await fallsBack(page));
  report("A channel without a stream says so and R asks once more", await noStream(page));
  report("A refusal says so, stops there and plays once free", await refusal(page));
  report("A stream that keeps dropping ends after four reconnects", await keepsDropping(page));
  report("A still picture waits, reconnects, and Stop ends the wait", await stallAndStop(page));
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  app.kill("SIGKILL");
  await provider.close();
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);

/** Picks a channel through search, which opens Watch on it. */
async function choose(page: Page, channel: string): Promise<void> {
  await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
  await delay(500);
  await page.send("Input.insertText", { text: channel });
  await delay(800);
  await key(page, "Enter", 13);
}

/** What Watch says in the middle of the picture, on one line. */
async function said(page: Page): Promise<string> {
  const text = await page.evaluate<string>(`document.querySelector("${BLOCK}")?.innerText ?? ""`);
  return text.replace(/\s+/g, " ");
}

/** What a failed or reconnecting channel offers, in order, besides closing its message. */
function offered(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(
    `[...document.querySelectorAll("${BLOCK} button:not([aria-label='Close message'])")].map((b) => b.textContent.trim())`,
  );
}

/** Whether the picture of the stream that plays now has moved for a second. */
function moves(page: Page): () => Promise<boolean> {
  return async () =>
    (await page.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`)) >= 1;
}

async function fallsBack(page: Page): Promise<{ ok: boolean; detail: string }> {
  const before = provider.streamRequests();
  await choose(page, "KWALITEIT 1");
  await waitFor(moves(page), 30_000);
  await waitFor(says(page, "Full HD didn't start, playing HD"), 10_000);
  await key(page, "q", 81);
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("[data-item]")`), 10_000);
  const rows = await page.evaluate<string[]>(
    `[...document.querySelectorAll("[data-item]")].map((b) => b.innerText.replace(/\\s+/g, " "))`,
  );
  await key(page, "Escape", 27);
  const asked = provider.streamRequests() - before;
  const ok = rows.includes("Full HD No stream · 404") && rows.includes("HD Playing") && asked === 2;
  return { ok, detail: `${rows.join(" | ")}; ${asked} stream requests` };
}

async function noStream(page: Page): Promise<{ ok: boolean; detail: string }> {
  const before = provider.streamRequests();
  await choose(page, "TEST | Offline");
  await waitFor(says(page, "No stream right now", BLOCK), 20_000);
  const text = await said(page);
  const actions = await offered(page);
  const first = provider.streamRequests() - before;
  await key(page, "r", 82);
  await waitFor(async () => provider.streamRequests() - before === 2, 10_000);
  // Nothing asks again by itself.
  await delay(4000);
  const asked = provider.streamRequests() - before;
  const ok =
    text.includes("HTTP 404") &&
    actions.join() === "Retry,Next channel,Channels" &&
    first === 1 &&
    asked === 2;
  return { ok, detail: `"${text}"; ${first} request, ${asked} after R and four seconds` };
}

async function refusal(page: Page): Promise<{ ok: boolean; detail: string }> {
  // Another device takes the subscription's one connection.
  await waitFor(async () => provider.activeStreams() === 0, 10_000);
  const elsewhere = new AbortController();
  const held = await fetch(`${provider.url}/live/demo/demo/1000.ts`, {
    signal: elsewhere.signal,
  });
  const before = provider.streamRequests();
  await choose(page, "KWALITEIT 1");
  await waitFor(says(page, "Refused by the provider", BLOCK), 20_000);
  const text = await said(page);
  const actions = await offered(page);
  await delay(5000);
  const asked = provider.streamRequests() - before;

  elsewhere.abort();
  await held.body?.cancel().catch(() => {});
  await waitFor(async () => provider.activeStreams() === 0, 10_000);
  await key(page, "r", 82);
  await waitFor(moves(page), 30_000);
  const ok =
    text.includes("HTTP 403") &&
    actions.join() === "Retry,Channels" &&
    // The stream asked for, and the two retries that give a slot time to clear.
    asked === 3;
  return {
    ok,
    detail: `"${text}", offering ${actions.join(", ")}; ${asked} requests in five seconds, then R played it`,
  };
}

async function keepsDropping(page: Page): Promise<{ ok: boolean; detail: string }> {
  after = "end";
  mostOpen = 0;
  const before = { sent, requests: provider.streamRequests() };
  await choose(page, "TEST | H.264 + AAC");
  const attempts = new Set<string>();
  await waitFor(async () => {
    const text = await said(page);
    const attempt = /attempt \d of \d/.exec(text)?.[0];
    if (attempt) attempts.add(attempt);
    return text.includes("Keeps dropping");
  }, 120_000);
  const text = await said(page);
  const streams = sent - before.sent;
  // Longer than the longest wait before a reconnect.
  await delay(12_000);
  const later = sent - before.sent;
  // The switch to this channel can find the slot of the stream before it still taken: the proxy
  // is refused and asks again, which is a request and no stream. So streams count, not requests.
  const requests = provider.streamRequests() - before.requests;
  after = "hold";
  const ok =
    streams === 5 &&
    later === 5 &&
    mostOpen === 1 &&
    provider.activeStreams() === 0 &&
    text.includes("4 reconnects") &&
    attempts.has("attempt 4 of 4");
  return {
    ok,
    detail: `"${text}"; ${streams} streams sent, ${later} twelve seconds on, ${mostOpen} at once, in ${requests} requests, saw ${[...attempts].join(", ")}`,
  };
}

async function stallAndStop(page: Page): Promise<{ ok: boolean; detail: string }> {
  const before = provider.streamRequests();
  await choose(page, "TEST | H.264 + AAC");
  await waitFor(moves(page), 30_000);
  // From here on the provider answers and sends nothing, so each reconnect fails at once.
  after = "nothing";
  await waitFor(says(page, "Waiting for data"), 20_000);
  const playing = (await said(page)) === "";
  // The wait before the third reconnect is four seconds: Stop falls inside it.
  await waitFor(says(page, "attempt 3 of 4", BLOCK), 60_000);
  const actions = await offered(page);
  const asked = provider.streamRequests() - before;
  await page.evaluate(
    `[...document.querySelectorAll("${BLOCK} button")].find((b) => b.textContent.trim() === "Stop").click()`,
  );
  await delay(12_000);
  const later = provider.streamRequests() - before;
  const text = await said(page);
  after = "hold";
  const ok =
    playing &&
    actions.join() === "Stop,Channels" &&
    later === asked &&
    provider.activeStreams() === 0 &&
    !text.includes("Reconnecting");
  return {
    ok,
    detail: `waited with the picture up: ${playing}; ${asked} streams asked for by the third wait, ${later} twelve seconds after Stop; now "${text}"`,
  };
}
