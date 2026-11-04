import { afterEach, expect, it, vi } from "vitest";
import { connect } from "./e2e/app.ts";

// A protocol peer delivering JSON text, including payloads deeper than a recursive validator.
class Socket {
  listeners = new Map<string, (event: MessageEvent) => void>();
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(name, listener);

    if (name === "open") queueMicrotask(() => listener(new MessageEvent("open")));
  }
  send(text: string) {
    const request: { id: number; method: string } = JSON.parse(text);
    const deep = "[".repeat(20000) + "0" + "]".repeat(20000);
    this.listeners.get("message")?.(
      new MessageEvent("message", {
        data: `{"method":"Deep.event","params":${deep}}`,
      }),
    );
    this.listeners.get("message")?.(
      new MessageEvent("message", {
        data: `{"id":${request.id},"${request.method === "fail" ? "error" : "result"}":${deep}}`,
      }),
    );
  }
  close() {
    this.listeners.get("close")?.(new MessageEvent("close"));
  }
}

afterEach(() => vi.unstubAllGlobals());

it("delivers deeply nested events, replies and errors without losing a pending command", async () => {
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", async () =>
    Response.json([
      {
        type: "page",
        url: "http://localhost/app",
        webSocketDebuggerUrl: "ws://localhost/devtools",
      },
    ]),
  );
  const page = await connect(1, "page", { pollMs: 0 });
  let events = 0;
  page.on("Deep.event", (params) => {
    if (Array.isArray(params)) events++;
  });

  try {
    const reply = await page.send("ok");
    expect(Array.isArray(reply.result)).toBe(true);
    const failure = await page.send("fail");
    expect(Array.isArray(failure.error)).toBe(true);
    expect(events).toBe(2);
  } finally {
    page.close();
  }
});
