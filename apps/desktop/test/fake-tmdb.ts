import type { Json } from "@mrstreamer/contracts/json";
// A stand-in for TMDB's API: every film and series it is asked about exists, with genres, a
// language and names that follow from its id (see `tmdbName`), every series has two seasons whose
// episodes are named the same way (see `tmdbEpisodeName`), one streaming service streams the
// first titles it is told about, and the people and franchise every title credits have titles of
// their own (see `PEOPLE` and `FRANCHISES`).
import { createServer } from "node:http";

export interface FakeTmdb {
  readonly url: string;
  /** Requests for one title's details so far, in one language or all. */
  detailRequests(language?: string): number;
  /** Requests a title's details made as it opened, with its credits, refused ones included. */
  aboutRequests(): number;
  /** Requests for a person's or franchise's titles so far: "person/1", "collection/10". */
  linkedRequests(): readonly string[];
  /** Season requests so far, in order, by series, season and language: "90000/1/nl". */
  seasonRequests(): readonly string[];
  /**
   * Makes season requests answer with this HTTP status, or not until another answer is set, or
   * restores them with null. Those held are answered as the next setting says.
   */
  failSeasons(answer: number | "hold" | null): void;
  /** Holds the answers to titles' details as they open, or sends those held and stops holding. */
  holdAbout(hold: boolean): void;
  /** Makes every request answer 401, as for a revoked key, or restores them. */
  refuse(refused: boolean): void;
  /** What the service streams, as TMDB ids, by kind. */
  stream(kind: "movie" | "tv", ids: readonly string[]): void;
  close(): Promise<void>;
}

/**
 * The name the fake TMDB gives title `id` in `language`, as TMDB answers: the original when it has
 * no translation. Every third title was made in Dutch, "Origineel 3", the rest in English,
 * "Original 1". English translates all but every fifth, "English 3"; Dutch all but every seventh,
 * "Nederlands 1". Other languages translate nothing.
 */
export function tmdbName(id: number, language: string): { name: string; original: string } {
  const madeIn = id % 3 === 0 ? "nl" : "en";
  const original = madeIn === "nl" ? `Origineel ${id}` : `Original ${id}`;

  if (language === madeIn) return { name: original, original };

  if (language === "en" && id % 5 !== 0) return { name: `English ${id}`, original };

  if (language === "nl" && id % 7 !== 0) return { name: `Nederlands ${id}`, original };

  return { name: original, original };
}

/**
 * The name the fake TMDB gives an episode of series `id` in `language`, "Episode 2" where it has
 * none, as TMDB answers. Series made in Dutch, every third, name theirs "Origineel 1x2", the rest
 * "Original 1x2". English translates the odd episodes, "English 1x3"; Dutch translates all,
 * "Nederlands 1x2"; other languages none.
 */
function tmdbEpisodeName(id: number, season: number, episode: number, language: string): string {
  const madeIn = id % 3 === 0 ? "nl" : "en";
  const numbered = `${season}x${episode}`;

  if (language === madeIn) return `${madeIn === "nl" ? "Origineel" : "Original"} ${numbered}`;

  if (language === "en" && episode % 2 === 1) return `English ${numbered}`;

  if (language === "nl") return `Nederlands ${numbered}`;

  return `Episode ${episode}`;
}

/**
 * The people every title credits, by TMDB person id, with what they are credited for: Alan
 * Actor plays in every title, Grace Director directs every film and Ada Creator created every
 * series. Ids 999990 and up are titles no fake provider lists.
 */
const PEOPLE: Readonly<Record<number, { readonly name: string; readonly credits: Json }>> = {
  1: {
    name: "Alan Actor",
    credits: {
      cast: [
        { id: 100002, media_type: "movie", release_date: "2001-05-01" },
        { id: 90000, media_type: "tv", first_air_date: "2010-09-01" },
        { id: 999999, media_type: "movie", release_date: "2020-01-01" },
        { id: 100003, media_type: "movie", release_date: "2005-03-01" },
        { id: 100005, media_type: "movie", release_date: "" },
      ],
      // Not what he made: a producer's credit is no link of the title's.
      crew: [{ id: 100001, media_type: "movie", job: "Producer", release_date: "2015-01-01" }],
    },
  },
  2: {
    name: "Grace Director",
    credits: { crew: [{ id: 100001, media_type: "movie", job: "Director" }] },
  },
  3: {
    name: "Ada Creator",
    credits: { crew: [{ id: 90000, media_type: "tv", job: "Creator" }] },
  },
};

/** The film franchise every film belongs to, by TMDB collection id, with its films. */
const FRANCHISES: Readonly<Record<number, { readonly name: string; readonly parts: Json }>> = {
  10: {
    name: "Test Saga",
    parts: [
      { id: 100004, media_type: "movie", release_date: "2003-01-01" },
      { id: 999998, media_type: "movie", release_date: "2001-01-01" },
      { id: 100000, media_type: "movie", release_date: "1999-01-01" },
    ],
  },
};

/** Episodes per season the fake TMDB lists for every series: four, then one. */
const SEASON_EPISODES = [4, 1];

export async function startFakeTmdb(): Promise<FakeTmdb> {
  const details = new Map<string, number>();
  let about = 0;
  let refused = false;
  const seasons: string[] = [];
  const linked: string[] = [];
  let seasonFailure: number | "hold" | null = null;
  /** Season requests waiting while their answers are held. */
  const heldSeasons: (() => void)[] = [];
  let aboutHeld = false;
  /** Answers to a title's details as it opens, waiting while they are held. */
  const held: (() => void)[] = [];
  const streamed: Record<string, readonly string[]> = { movie: [], tv: [] };

  const json = (response: import("node:http").ServerResponse, body: Json, status = 200) =>
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://tmdb");
    const opened = url.searchParams.get("append_to_response") === "credits";

    if (opened) about++;

    if (refused) return json(response, { status_code: 7 }, 401);
    const season = /^\/3\/tv\/(\d+)\/season\/(\d+)$/.exec(url.pathname);

    if (season) {
      const language = url.searchParams.get("language") ?? "en";
      const id = Number(season[1]);
      const number = Number(season[2]);
      seasons.push(`${id}/${number}/${language}`);

      const answer = (): void => {
        if (seasonFailure === "hold") return void heldSeasons.push(answer);

        if (seasonFailure !== null) return void json(response, { status_code: 11 }, seasonFailure);
        const count = SEASON_EPISODES[number - 1];

        if (count === undefined) return void json(response, { status_code: 34 }, 404);
        json(response, {
          season_number: number,
          episodes: Array.from({ length: count }, (_, index) => {
            const episode = index + 1;
            const name = tmdbEpisodeName(id, number, episode, language);

            return {
              episode_number: episode,
              season_number: number,
              name,
              overview: name.startsWith("Episode") ? "" : `TMDB's story of ${name}.`,
              still_path: `/still-${id}-${number}-${episode}.jpg`,
              air_date: `2020-0${number}-0${episode}`,
              runtime: 50,
              vote_average: 8.2,
              // Too few votes on the third for a rating that says much.
              vote_count: episode === 3 ? 4 : 12,
              crew: [
                { name: "Dora Director", job: "Director" },
                { name: "Wim Writer", job: "Writer" },
                { name: "Cas Camera", job: "Director of Photography" },
              ],
              guest_stars: [
                { name: "Gus Guest", character: "The Visitor", profile_path: "/gus.jpg" },
              ],
            };
          }),
        });
      };

      return answer();
    }

    const person = /^\/3\/(person|collection)\/(\d+)$/.exec(url.pathname);

    if (person) {
      const id = Number(person[2]);
      linked.push(`${person[1]}/${id}`);

      if (person[1] === "person") {
        const known = PEOPLE[id];

        return known
          ? json(response, { id, name: known.name, combined_credits: known.credits })
          : json(response, { status_code: 34 }, 404);
      }

      const known = FRANCHISES[id];

      return known
        ? json(response, { id, name: known.name, parts: known.parts })
        : json(response, { status_code: 34 }, 404);
    }

    const title = /^\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname);

    if (title) {
      const language = url.searchParams.get("language") ?? "en";
      details.set(language, (details.get(language) ?? 0) + 1);
      const id = Number(title[2]);
      const { name, original } = tmdbName(id, language);
      const series = title[1] === "tv";

      const answer = () => {
        const listed = {
          ...(series
            ? { name, original_name: original }
            : { title: name, original_title: original }),
          // Odd ids are comedies, even ones dramas; every third is Dutch.
          genres: [{ id: id % 2 ? 35 : 18 }],
          original_language: id % 3 === 0 ? "nl" : "en",
          popularity: id % 100,
          vote_average: 7.5,
          vote_count: 400,
          belongs_to_collection: null,
          backdrop_path: `/backdrop-${id}.jpg`,
        };

        // What a title's details ask for when it opens.
        return json(
          response,
          opened
            ? {
                ...listed,
                overview: `TMDB's story of ${name}.`,
                poster_path: `/poster-${id}.jpg`,
                runtime: series ? null : 101,
                episode_run_time: series ? [44] : undefined,
                created_by: series ? [{ id: 3, name: "Ada Creator" }] : undefined,
                belongs_to_collection: series ? undefined : { id: 10, name: "Test Saga" },
                credits: {
                  cast: [
                    { id: 1, name: "Alan Actor", character: "The Lead", profile_path: "/alan.jpg" },
                  ],
                  crew: [{ id: 2, name: "Grace Director", job: "Director" }],
                },
              }
            : listed,
        );
      };

      if (opened && aboutHeld) return void held.push(answer);

      return answer();
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
    aboutRequests: () => about,
    linkedRequests: () => [...linked],
    seasonRequests: () => [...seasons],
    failSeasons: (answer) => {
      seasonFailure = answer;

      if (answer !== "hold") for (const held of heldSeasons.splice(0)) held();
    },
    holdAbout: (hold) => {
      aboutHeld = hold;

      if (!hold) for (const answer of held.splice(0)) answer();
    },
    detailRequests: (language) =>
      language === undefined
        ? [...details.values()].reduce((sum, count) => sum + count, 0)
        : (details.get(language) ?? 0),
    refuse: (value) => {
      refused = value;
    },
    stream: (kind, ids) => {
      streamed[kind] = ids;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // A season held open would keep it from closing.
        server.closeAllConnections();
      }),
  };
}
