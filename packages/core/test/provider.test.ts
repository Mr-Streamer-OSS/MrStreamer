// What `providerFetch` sends where once an address is https. Nothing holding the login goes to an
// http address, whether a redirect leads there or a playlist names it, and a header holding it
// stays with the address it came for. Plain http is a real loopback server that notes everything
// reaching it; https addresses are answered here, as a provider and its CDNs answer.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { providerFetch } from "../src/provider.ts";

const USER = "synthetic-user";
const SECRET = "synthetic-secret";
/** A short password, and the format words a panel's playlist link carries beside the login. */
const PIN = "k9x";
const LOGIN = [USER, SECRET, PIN, "ts", "m3u8"];
const REFERER = `https://site.test/watch?token=${SECRET}`;

let server: Server;
let plain = "";
/** Every request the http server got. */
const reached: { path: string; headers: IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    reached.push({ path: request.url ?? "", headers: request.headers });
    // An http hop that leads on to the login, as a relay's load balancer could.
    if (request.url === "/hop")
      return response.writeHead(302, { location: `/media/${SECRET}` }).end();
    response.end("plain");
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  plain = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
});
beforeEach(() => {
  reached.length = 0;
});

/**
 * Fetch where each https address in `redirects` leads where it says, any other answers, and http
 * goes to the loopback server. `asked` notes every https request with its headers.
 */
function world(redirects: Readonly<Record<string, string>> = {}) {
  const asked: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol === "http:") return fetch(url, init);
    asked.push({ url: url.href, headers: new Headers(init?.headers) });
    const location = redirects[url.href];
    return location
      ? new Response(null, { status: 302, headers: { location } })
      : new Response("secure");
  };
  return { asked, request: providerFetch(fetchImpl, LOGIN) };
}

const START = "https://panel.test/live/stream.ts";

describe("redirects from https to http", () => {
  it.each([
    ["the password as a query value", () => `${plain}/media?token=${SECRET}`],
    ["the password as a path segment", () => `${plain}/media/${SECRET}`],
    ["both in one field", () => `${plain}/media?auth=${USER}%3A${SECRET}`],
    ["both in one field, encoded twice", () => `${plain}/media?auth=${USER}%253A${SECRET}`],
    ["the password encoded twice", () => `${plain}/media?auth=synthetic%252Dsecret`],
    ["the password joined to other text", () => `${plain}/media/x${USER}${SECRET}y.ts`],
    ["the password as a query key", () => `${plain}/media?${SECRET}`],
    ["the user name in a path segment", () => `${plain}/${encodeURIComponent(USER)}/live.ts`],
    ["a short password as a whole part", () => `${plain}/media?auth=guest:${PIN}`],
    ["a short password as a path segment", () => `${plain}/media/${PIN}/live.ts`],
  ])("refuses one with %s, sending nothing to http", async (_case, target) => {
    const { request } = world({ [START]: target() });
    await expect(request(START)).rejects.toThrow("unencrypted");
    expect(reached).toEqual([]);
  });

  it.each([
    ["a token of its own", () => `${plain}/relay/live.ts?token=7f3a`],
    ["the link's format words inside names", () => `${plain}/relay/index.m3u8?ts=1700000000`],
  ])("follows one with %s", async (_case, target) => {
    const { request } = world({ [START]: target() });
    expect(await (await request(START)).text()).toBe("plain");
    expect(reached).toHaveLength(1);
  });

  it("refuses the login however many hops lead to http, past another https server or an http one", async () => {
    const edge = "https://edge.test/live/stream.ts";
    const viaEdge = world({ [START]: edge, [edge]: `${plain}/media?auth=${USER}%3A${SECRET}` });
    await expect(viaEdge.request(START)).rejects.toThrow("unencrypted");
    expect(viaEdge.asked.map((each) => each.url)).toEqual([START, edge]);
    expect(reached).toEqual([]);

    const viaHttp = world({ [START]: `${plain}/hop` });
    await expect(viaHttp.request(START)).rejects.toThrow("unencrypted");
    // The http hop held nothing of the login; the one it led to is never asked.
    expect(reached.map((each) => each.path)).toEqual(["/hop"]);
  });
});

describe("addresses a playlist names", () => {
  const PLAYLIST = "https://cdn.test/live/index.m3u8";

  it("sends nothing to an http one with the login after an https playlist", async () => {
    const { request } = world();
    await expect(request(`${plain}/segment.ts?token=${SECRET}`, {}, PLAYLIST)).rejects.toThrow(
      "unencrypted",
    );
    await expect(request(`${plain}/key?auth=${USER}%3A${SECRET}`, {}, PLAYLIST)).rejects.toThrow(
      "unencrypted",
    );
    expect(reached).toEqual([]);
  });

  it("refuses an https one that redirects to http with the login", async () => {
    const segment = "https://cdn.test/live/segment.ts";
    const { request } = world({ [segment]: `${plain}/segment.ts?token=${SECRET}` });
    await expect(request(segment, {}, PLAYLIST)).rejects.toThrow("unencrypted");
    expect(reached).toEqual([]);
  });

  it("asks an http one without the login, and every one an http playlist names", async () => {
    const { request } = world();
    expect((await request(`${plain}/segment.ts?relay=7f3a`, {}, PLAYLIST)).ok).toBe(true);
    const http = `${plain}/live/index.m3u8`;
    expect((await request(`${plain}/segment.ts?token=${SECRET}`, {}, http)).ok).toBe(true);
    expect(reached.map((each) => each.path)).toEqual([
      "/segment.ts?relay=7f3a",
      `/segment.ts?token=${SECRET}`,
    ]);
  });
});

describe("the headers a stream asks for", () => {
  const headers = { "User-Agent": "SyntheticPlayer/1.0", Referer: REFERER };

  it("go as they are to the stream's own origin", async () => {
    const moved = "https://panel.test/live/moved.ts";
    const { request, asked } = world({ [START]: moved });
    await request(START, { headers });
    expect(asked.map((each) => each.headers.get("referer"))).toEqual([REFERER, REFERER]);
  });

  it.each(["Referer", "referer", "REFERER"])(
    "cut a %s holding the login to its origin on the way to another https server",
    async (name) => {
      const edge = "https://edge.test/live/stream.ts";
      const { request, asked } = world({ [START]: edge });
      await request(START, { headers: { "User-Agent": "SyntheticPlayer/1.0", [name]: REFERER } });
      expect(asked[1]?.url).toBe(edge);
      expect(asked[1]?.headers.get("referer")).toBe("https://site.test/");
      expect(asked[1]?.headers.get("user-agent")).toBe("SyntheticPlayer/1.0");
    },
  );

  it("leave out another header holding the login, and keep the rest, past the origin", async () => {
    const edge = "https://edge.test/live/stream.ts";
    const { request, asked } = world({ [START]: edge });
    await request(START, { headers: { "X-Session": `id ${SECRET}`, "X-Device": "desktop" } });
    expect(asked[0]?.headers.get("x-session")).toBe(`id ${SECRET}`);
    expect(asked[1]?.headers.has("x-session")).toBe(false);
    expect(asked[1]?.headers.get("x-device")).toBe("desktop");
  });

  it("send nothing of the login to http, and an ordinary Referer as it is", async () => {
    const { request } = world({ [START]: `${plain}/relay/live.ts?token=7f3a` });
    await request(START, { headers });
    await request(START, { headers: { Referer: "https://site.test/watch" } });
    expect(reached.map((each) => each.headers.referer)).toEqual([
      "https://site.test/",
      "https://site.test/watch",
    ]);
    expect(reached[0]?.headers["user-agent"]).toBe("SyntheticPlayer/1.0");
    expect(JSON.stringify(reached)).not.toContain(SECRET);
  });

  it("leave a playlist's segment on another origin with the Referer's origin only", async () => {
    const { request } = world();
    await request(`${plain}/segment.ts`, { headers }, "https://cdn.test/live/index.m3u8");
    expect(reached[0]?.headers.referer).toBe("https://site.test/");
  });
});
