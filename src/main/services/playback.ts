// Stream sessions and the loopback proxy that serves them to the UI.
//
// The UI never sees provider URLs: they carry the login. It gets a 127.0.0.1 URL with a random
// token instead. Only one session is open at a time, so switching channels always releases the
// previous provider connection first. Many subscriptions allow a single connection.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { AppFailure } from "../../shared/errors.ts";
import type { StreamFailure, StreamFormat, StreamSession } from "../../shared/playback.ts";
import type { CatalogueSource } from "./library.ts";

/** How long the provider gets to start answering before the stream counts as failed. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Waits before retrying a refused stream. Providers can take a moment to free the slot of a stream we just closed. */
const REFUSED_RETRY_DELAYS_MS = [500, 1500];

interface Session {
  readonly id: string;
  readonly token: string;
  readonly channelId: string;
  readonly upstreamUrl: string;
  readonly format: StreamFormat;
  /** Aborts every upstream request of this session. */
  readonly closed: AbortController;
  /** The request currently being served. A new request for the same session replaces it. */
  active: AbortController | null;
  failure: StreamFailure | null;
}

export interface PlaybackDeps {
  readonly source: () => Promise<CatalogueSource | null>;
  readonly userAgent: string;
  readonly fetch?: typeof fetch;
}

export type Playback = ReturnType<typeof createPlayback>;

export function createPlayback(deps: PlaybackDeps) {
  const fetchImpl = deps.fetch ?? fetch;
  const sessions = new Map<string, Session>();
  let server: Promise<{ server: Server; port: number }> | null = null;

  function listen(): Promise<{ server: Server; port: number }> {
    server ??= new Promise((resolve, reject) => {
      const http = createServer((request, response) => {
        void serve(request, response);
      });
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        const address = http.address();
        if (address && typeof address === "object") resolve({ server: http, port: address.port });
        else reject(new Error("Stream proxy has no TCP address."));
      });
    });
    return server;
  }

  function closeSession(session: Session): void {
    session.closed.abort();
    sessions.delete(session.id);
  }

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Headers": "Range" }).end();
      return;
    }
    const token = /^\/stream\/([\w-]+)\.\w+$/.exec(request.url ?? "")?.[1];
    const session = [...sessions.values()].find((candidate) => candidate.token === token);
    if (!session || request.method !== "GET") {
      response.writeHead(410).end();
      return;
    }

    session.active?.abort();
    const active = new AbortController();
    session.active = active;
    response.on("close", () => active.abort());
    const signal = AbortSignal.any([session.closed.signal, active.signal]);

    const upstream = await connect(session, signal);
    if (signal.aborted) {
      response.destroy();
      return;
    }
    if (!upstream.ok) {
      session.failure = upstream.failure;
      response.writeHead(upstream.failure.kind === "network" ? 502 : upstream.failure.status).end();
      return;
    }

    response.writeHead(200, { "Content-Type": upstream.contentType ?? "video/mp2t" });
    const body = Readable.fromWeb(upstream.body);
    body.on("error", (cause) => {
      if (!signal.aborted) session.failure = { kind: "network", detail: String(cause) };
      response.destroy();
    });
    body.pipe(response);
  }

  /** Opens the upstream request, retrying briefly when the provider refuses. */
  async function connect(
    session: Session,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; body: ReadableStream<Uint8Array>; contentType: string | null }
    | { ok: false; failure: StreamFailure }
  > {
    for (let attempt = 0; ; attempt++) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), CONNECT_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(session.upstreamUrl, {
          headers: { "User-Agent": deps.userAgent },
          signal: AbortSignal.any([signal, timeout.signal]),
        });
      } catch (cause) {
        return {
          ok: false,
          failure: {
            kind: "network",
            detail: timeout.signal.aborted ? "The provider did not answer in time." : String(cause),
          },
        };
      } finally {
        clearTimeout(timer);
      }

      if (response.ok && response.body) {
        return { ok: true, body: response.body, contentType: response.headers.get("content-type") };
      }
      await response.body?.cancel();
      const failure = classify(response.status);
      const delay = REFUSED_RETRY_DELAYS_MS[attempt];
      if (failure.kind !== "refused" || delay === undefined || signal.aborted)
        return { ok: false, failure };
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    /** Opens a stream for a channel. Closes any open stream first. */
    async open(channelId: string): Promise<StreamSession> {
      const source = await deps.source();
      if (!source) throw new AppFailure({ kind: "no-subscription" });
      for (const session of sessions.values()) closeSession(session);

      const upstream = source.provider.liveStream(channelId);
      const session: Session = {
        id: randomUUID(),
        token: randomBytes(18).toString("base64url"),
        channelId,
        upstreamUrl: upstream.url,
        format: upstream.format,
        closed: new AbortController(),
        active: null,
        failure: null,
      };
      sessions.set(session.id, session);
      const { port } = await listen();
      const extension = upstream.format === "mpegts" ? "ts" : "m3u8";
      return {
        sessionId: session.id,
        channelId,
        url: `http://127.0.0.1:${port}/stream/${session.token}.${extension}`,
        format: upstream.format,
      };
    },

    /** Closes every open stream, for example when the window closes. */
    closeAll(): void {
      for (const session of sessions.values()) closeSession(session);
    },

    /** Closes a stream and its provider connection. Unknown or already closed ids are ignored. */
    close(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (session) closeSession(session);
    },

    /** Why the session's last upstream request failed, or null. */
    failure(sessionId: string): StreamFailure | null {
      return sessions.get(sessionId)?.failure ?? null;
    },

    async dispose(): Promise<void> {
      for (const session of sessions.values()) closeSession(session);
      const running = await server;
      running?.server.closeAllConnections();
      running?.server.close();
      server = null;
    },
  };
}

function classify(status: number): StreamFailure {
  if (status === 401 || status === 403 || status === 429 || status === 458 || status === 509) {
    return { kind: "refused", status };
  }
  if (status === 404 || status === 410) return { kind: "unavailable", status };
  return { kind: "provider-error", status };
}
