// A fake host for XMLTV guides at addresses of their own, apart from any provider, as a guide
// service publishes them: one file behind an address that carries a key. Tests say what each
// path answers: a document, plain or packed, whole or in pieces of a few bytes; an HTTP status
// that fails it; a redirect; or nothing, until they let go. It notes every request with the
// headers it came with.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** The key in every address the host gives out, which must show nowhere outside the request. */
export const GUIDE_KEY = "k3y-n0b0dy-sh0uld-s33";

type Answer =
  | string
  | Buffer
  /** An HTTP status that fails the request. */
  | number
  | { readonly redirect: string };

export interface GuideHost {
  readonly origin: string;
  /** The address of the guide at `path`, with the key in its query. */
  address(path?: string): string;
  /**
   * Puts `answer` at `path`. `pieceBytes` sends a document in writes of that size, and `headers`
   * with these, as for one the server says it packed itself.
   */
  serve(
    path: string,
    answer: Answer,
    options?: { readonly pieceBytes?: number; readonly headers?: Readonly<Record<string, string>> },
  ): void;
  /** Every request so far, in order. */
  requests(): readonly {
    readonly path: string;
    readonly search: string;
    readonly headers: IncomingHttpHeaders;
  }[];
  /**
   * Leaves requests unanswered. `arrived` settles when the first reaches the host, and `release`
   * has them answered.
   */
  hold(): { readonly arrived: Promise<void>; release(): void };
  close(): Promise<void>;
}

export async function startGuideHost(): Promise<GuideHost> {
  const asked: ReturnType<GuideHost["requests"]>[number][] = [];
  const routes = new Map<
    string,
    { readonly answer: Answer; readonly options: Parameters<GuideHost["serve"]>[2] }
  >();
  let held: { readonly arrived: () => void; readonly released: Promise<void> } | null = null;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://host");
    asked.push({ path: url.pathname, search: url.search, headers: request.headers });
    const respond = () => {
      const route = routes.get(url.pathname);
      if (!route) return void response.writeHead(404).end();
      const { answer, options = {} } = route;
      if (typeof answer === "number") return void response.writeHead(answer).end();
      if (typeof answer === "object" && "redirect" in answer) {
        return void response.writeHead(302, { Location: answer.redirect }).end();
      }
      const bytes = Buffer.from(answer);
      response.writeHead(200, options.headers);
      const size = options.pieceBytes ?? bytes.length;
      let offset = 0;
      const next = () => {
        if (offset >= bytes.length) return void response.end();
        response.write(bytes.subarray(offset, offset + size));
        offset += size;
        setImmediate(next);
      };
      next();
    };
    if (!held) return respond();
    held.arrived();
    void held.released.then(respond);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    address: (path = "/guide.xml") => `${origin}${path}?key=${GUIDE_KEY}`,
    serve(path, answer, options) {
      routes.set(path, { answer, options });
    },
    requests: () => asked,
    hold() {
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      held = { arrived: arrived.resolve, released: released.promise };
      return {
        arrived: arrived.promise,
        release() {
          held = null;
          released.resolve();
        },
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    },
  };
}
