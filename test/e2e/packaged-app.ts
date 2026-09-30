// Smoke test for a built app: connects it to the fake provider through the login form, then plays
// a stream the player decodes directly and one the bundled ffmpeg has to convert. Then it leaves
// Watch for Home and comes back, which must keep the one stream rather than open another.
//
//   node test/e2e/packaged-app.ts <app executable> [-- extra app arguments]
//
// Passes when both channels show a moving picture with decoded sound, and Home and Watch share the
// stream: muted on Home, with sound in Watch, and no second request to the provider. The app runs with a
// throwaway profile and remote debugging on a random port; on macOS pass --use-mock-keychain so
// the test never touches a real keychain.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProvider } from "../fake-provider.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Usage: node test/e2e/packaged-app.ts <app executable> [-- args]");

const CHANNELS = ["TEST | H.264 + AAC", "TEST | H.264 + MP2"];
const port = 20000 + Math.floor(Math.random() * 20000);
const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const provider = await startFakeProvider({ channels: 60, live: true });
const app = spawn(
  executable,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...rest],
  { stdio: ["ignore", "inherit", "inherit"] },
);

let failed = false;
try {
  const page = await connect();
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page);
  for (const channel of CHANNELS) {
    const result = await play(page, channel);
    console.log(`${result.ok ? "PASS" : "FAIL"} ${channel}: ${result.detail}`);
    failed ||= !result.ok;
  }
  const shared = await homeAndBack(page);
  console.log(`${shared.ok ? "PASS" : "FAIL"} Home and Watch share one stream: ${shared.detail}`);
  failed ||= !shared.ok;
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

type Page = Awaited<ReturnType<typeof connect>>;

/** A minimal DevTools protocol client for the app's window. */
async function connect() {
  let url: string | undefined;
  for (let attempt = 0; attempt < 150 && !url; attempt++) {
    await delay(200);
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      url = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
    } catch {}
  }
  if (!url) throw new Error("The app opened no window within 30 s.");
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => resolve({ error: `${method} timed out` }), 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    async evaluate<T>(expression: string): Promise<T> {
      const reply = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return (reply.result as { result: { value: T } }).result.value;
    },
    close: () => socket.close(),
  };
}

async function login(page: Page): Promise<void> {
  await waitFor(() =>
    page.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
  );
  const fields = [provider.url, "demo", "demo"];
  await page.evaluate(`(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const fields = ${JSON.stringify(fields)};
    document.querySelectorAll("form input").forEach((input, index) => {
      setValue.call(input, fields[index]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    document.querySelector('form button[type="submit"]').click();
  })()`);
  await waitFor(() =>
    page.evaluate<boolean>(
      "!!document.querySelector('header') && !document.body.innerText.includes('Loading channels')",
    ),
  );
}

/** Picks a channel through search and waits for picture and sound. */
async function play(page: Page, channel: string): Promise<{ ok: boolean; detail: string }> {
  await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
  await delay(500);
  await page.send("Input.insertText", { text: channel });
  await delay(800);
  await key(page, "Enter", 13);
  const until = Date.now() + 25_000;
  let last = { time: 0, width: 0, audio: 0, title: "" };
  while (Date.now() < until) {
    await delay(250);
    last = await page.evaluate(`(() => {
      const video = document.querySelector("video");
      return {
        time: video?.currentTime ?? 0,
        width: video?.videoWidth ?? 0,
        audio: video?.webkitAudioDecodedByteCount ?? 0,
        title: document.querySelector("h2")?.textContent ?? "",
      };
    })()`);
    if (last.time >= 1 && last.width > 0 && last.audio > 0) {
      return {
        ok: true,
        detail: `picture ${last.width} px wide, ${last.audio} bytes of sound decoded`,
      };
    }
  }
  return {
    ok: false,
    detail: `clock ${last.time.toFixed(2)} s, width ${last.width}, sound ${last.audio} bytes, "${last.title}"`,
  };
}

/** Leaves Watch for Home, where the stream plays on muted, then watches it again from there. */
async function homeAndBack(page: Page): Promise<{ ok: boolean; detail: string }> {
  const requests = provider.streamRequests();
  const state = () =>
    page.evaluate<{ watching: boolean; muted: boolean; playing: boolean }>(`(() => {
      const video = document.querySelector("video");
      return {
        watching: !!document.querySelector('[data-view="watch"]'),
        muted: !!video?.muted,
        playing: !!video && video.isConnected && !video.paused,
      };
    })()`);
  await key(page, "Escape", 27);
  await waitFor(async () => !(await state()).watching, 10_000);
  const home = await state();
  await page.evaluate(
    `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Watch").click()`,
  );
  await waitFor(async () => (await state()).watching, 10_000);
  await delay(1000);
  const watch = await state();
  const extra = provider.streamRequests() - requests;
  const ok = home.playing && home.muted && watch.playing && !watch.muted && extra === 0;
  return {
    ok,
    detail: `Home ${home.playing ? "playing" : "stopped"}${home.muted ? " muted" : " with sound"}, Watch ${watch.playing ? "playing" : "stopped"}${watch.muted ? " muted" : " with sound"}, ${extra} more stream requests, ${provider.activeStreams()} open`,
  };
}

async function key(page: Page, name: string, code: number): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
    });
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${check.toString()}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
