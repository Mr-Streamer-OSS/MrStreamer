// A stand-in for TMDB's API: every film and series it is asked about exists, with genres that
// follow from its id, and one streaming service streams the first titles it is told about.
import { createServer } from "node:http";

export interface FakeTmdb {
  readonly url: string;
  /** Requests for one title's details so far. */
  detailRequests(): number;
  /** Makes every request answer 401, as for a revoked key, or restores them. */
  refuse(refused: boolean): void;
  /** What the service streams, as TMDB ids, by kind. */
  stream(kind: "movie" | "tv", ids: readonly string[]): void;
  close(): Promise<void>;
}

export async function startFakeTmdb(): Promise<FakeTmdb> {
  let details = 0;
  let refused = false;
  const streamed: Record<string, readonly string[]> = { movie: [], tv: [] };
  const json = (response: import("node:http").ServerResponse, body: unknown, status = 200) =>
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://tmdb");
    if (refused) return json(response, { status_code: 7 }, 401);
    const title = /^\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (title) {
      details++;
      const id = Number(title[2]);
      return json(response, {
        // Odd ids are comedies, even ones dramas; every third is Dutch.
        genres: [{ id: id % 2 ? 35 : 18 }],
        original_language: id % 3 === 0 ? "nl" : "en",
        popularity: id % 100,
        vote_average: 7.5,
        vote_count: 400,
        belongs_to_collection: null,
        backdrop_path: `/backdrop-${id}.jpg`,
      });
    }
    const services = /^\/3\/watch\/providers\/(movie|tv)$/.exec(url.pathname);
    if (services) {
      return json(response, {
        results: [
          { provider_id: 8, provider_name: "Netflix", display_priorities: { NL: 1 } },
          { provider_id: 72, provider_name: "Videoland", display_priorities: { NL: 2 } },
        ],
      });
    }
    const discover = /^\/3\/discover\/(movie|tv)$/.exec(url.pathname);
    if (discover) {
      const kind = discover[1] ?? "movie";
      const ids = url.searchParams.get("with_watch_providers") === "8" ? streamed[kind] : [];
      return json(response, {
        page: 1,
        total_pages: 1,
        results: (ids ?? []).map((id) => ({ id: Number(id) })),
      });
    }
    json(response, { status_code: 34 }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/3`,
    detailRequests: () => details,
    refuse: (value) => {
      refused = value;
    },
    stream: (kind, ids) => {
      streamed[kind] = ids;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
