// A local Xtream Codes style provider for development and tests.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildCatalogue, type MockCatalogue, type MockChannel } from "./catalogue.ts";
import type { StreamSource } from "./streams.ts";

export interface MockProviderOptions {
  readonly streams: StreamSource;
  /** 0 picks a free port. */
  readonly port?: number;
  readonly host?: string;
  readonly username?: string;
  readonly password?: string;
  readonly channels?: number;
  readonly maxConnections?: number;
  readonly accountStatus?: "Active" | "Expired" | "Banned" | "Disabled";
  /** How long a closed stream keeps its connection slot. Real panels often lag behind. */
  readonly slotReleaseMs?: number;
  readonly log?: (line: string) => void;
}

export interface MockProvider {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly catalogue: MockCatalogue;
  /** Streams currently holding a connection slot. */
  activeStreams(): number;
  close(): Promise<void>;
}

export async function startMockProvider(options: MockProviderOptions): Promise<MockProvider> {
  const username = options.username ?? "demo";
  const password = options.password ?? "demo";
  const maxConnections = options.maxConnections ?? 1;
  const slotReleaseMs = options.slotReleaseMs ?? 300;
  const log = options.log ?? (() => {});
  const catalogue = buildCatalogue(options.channels ?? 2000);
  const channels = new Map(
    catalogue.channels.map((channel) => [String(channel.streamId), channel]),
  );
  let slots = 0;
  let origin = "";

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/player_api.php") return api(url, response);
    const live = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.ts$/.exec(url.pathname);
    if (live) return stream(live[1] ?? "", live[2] ?? "", live[3] ?? "", request, response);
    const logo = /^\/logos\/(\d+)\.svg$/.exec(url.pathname);
    if (logo) return logoSvg(channels.get(logo[1] ?? ""), response);
    response.writeHead(404).end();
  });

  function api(url: URL, response: ServerResponse): void {
    if (
      url.searchParams.get("username") !== username ||
      url.searchParams.get("password") !== password
    ) {
      return json(response, { user_info: { auth: 0 } });
    }
    const action = url.searchParams.get("action");
    if (action === null) {
      const now = Math.floor(Date.now() / 1000);
      return json(response, {
        user_info: {
          username,
          password,
          message: "Mr. Streamer mock provider",
          auth: 1,
          status: options.accountStatus ?? "Active",
          exp_date: String(now + 180 * 24 * 60 * 60),
          is_trial: "0",
          active_cons: String(slots),
          created_at: "1700000000",
          max_connections: String(maxConnections),
          allowed_output_formats: ["m3u8", "ts"],
        },
        server_info: {
          url: url.hostname,
          port: url.port,
          server_protocol: "http",
          timezone: "Europe/Amsterdam",
          timestamp_now: now,
        },
      });
    }
    if (action === "get_live_categories") {
      return json(
        response,
        catalogue.categories.map((category) => ({
          category_id: category.id,
          category_name: category.name,
          parent_id: 0,
        })),
      );
    }
    if (action === "get_live_streams") {
      const categoryId = url.searchParams.get("category_id");
      return json(
        response,
        catalogue.channels
          .filter((channel) => !categoryId || channel.categoryId === categoryId)
          .map((channel) => ({
            // Real panels mix numbers and numeric strings.
            num: channel.num % 3 === 0 ? String(channel.num) : channel.num,
            name: channel.name,
            stream_type: "live",
            stream_id: channel.streamId,
            stream_icon: channel.hasLogo ? `${origin}/logos/${channel.streamId}.svg` : "",
            epg_channel_id: null,
            added: "1700000000",
            is_adult: "0",
            category_id: channel.categoryId,
            category_ids: [Number(channel.categoryId)],
            custom_sid: "",
            tv_archive: 0,
            direct_source: "",
            tv_archive_duration: 0,
          })),
      );
    }
    json(response, []);
  }

  function stream(
    user: string,
    pass: string,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const channel = channels.get(id);
    if (decodeURIComponent(user) !== username || decodeURIComponent(pass) !== password) {
      log(`stream ${id}: 401 wrong login`);
      return void response.writeHead(401).end();
    }
    if (!channel || channel.profile === "offline") {
      log(`stream ${id}: 404 offline`);
      return void response.writeHead(404).end();
    }
    if (slots >= maxConnections) {
      log(`stream ${id}: 403 all ${maxConnections} connection(s) in use`);
      return void response.writeHead(403).end();
    }

    slots++;
    log(`stream ${id} "${channel.name}": open (${slots}/${maxConnections})`);
    const closed = new AbortController();
    request.on("close", () => {
      if (closed.signal.aborted) return;
      closed.abort();
      log(`stream ${id}: closed`);
      setTimeout(() => slots--, slotReleaseMs);
    });

    const begin = () => {
      if (closed.signal.aborted) return;
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      options.streams(channel, response, closed.signal);
    };
    if (channel.profile === "slow-start") setTimeout(begin, 6000);
    else begin();
    if (channel.profile === "drops") {
      setTimeout(() => {
        log(`stream ${id}: dropping connection on purpose`);
        response.destroy();
      }, 20_000);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider has no TCP address.");
  origin = `http://${options.host ?? "127.0.0.1"}:${address.port}`;

  return {
    url: origin,
    username,
    password,
    catalogue,
    activeStreams: () => slots,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function logoSvg(channel: MockChannel | undefined, response: ServerResponse): void {
  if (!channel) return void response.writeHead(404).end();
  const initials = channel.name.replace(/^[A-Z]{2}\s*[:|]\s*/, "").slice(0, 2);
  response
    .writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" })
    .end(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="hsl(${channel.hue} 45% 28%)"/>` +
        `<text x="80" y="58" font-family="Helvetica, Arial, sans-serif" font-size="38" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text></svg>`,
    );
}
