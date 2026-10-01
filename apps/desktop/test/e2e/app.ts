// Drives a built app over the DevTools protocol, against the fake provider. Shared by the
// packaged-app test and the measuring script.
import { spawn, type ChildProcess } from "node:child_process";
import type { FakeProvider } from "../fake-provider.ts";

/** Starts the app with remote debugging on `port` and its data in `profile`. */
export function launch(
  executable: string,
  args: readonly string[],
  options: { port: number; profile: string },
): ChildProcess {
  return spawn(
    executable,
    [`--remote-debugging-port=${options.port}`, `--user-data-dir=${options.profile}`, ...args],
    // No automatic update checks and no TMDB, a closed port unless the caller serves one: both
    // would reach the network in the middle of a measurement.
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        MR_STREAMER_UPDATE_CHECKS: "off",
        MR_STREAMER_TMDB_API: process.env["MR_STREAMER_TMDB_API"] ?? "http://127.0.0.1:9/3",
      },
    },
  );
}

export type Page = Awaited<ReturnType<typeof connect>>;

/** A minimal DevTools protocol client for the app's window. */
export async function connect(port: number) {
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

/** Connects the fake provider through the login form and waits for the channels. */
export async function login(page: Page, provider: FakeProvider): Promise<void> {
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

/** Presses a key in the window. */
export async function key(page: Page, name: string, code: number): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
    });
  }
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${check.toString()}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
