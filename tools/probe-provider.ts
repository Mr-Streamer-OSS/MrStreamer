// Inspects a real subscription through the app's own Xtream adapter: account, catalogue and stream formats.
// Usage: node tools/probe-provider.ts [--config .local/subscription.json] [--streams 6]
// The config file holds { "server", "username", "password" } and must stay out of git (.local/ is ignored).
// Stream probes need ffprobe on PATH and use one provider connection each, one at a time.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseLogin, xtreamProvider } from "../src/main/providers/xtream.ts";
import type { ProviderChannel } from "../src/main/providers/provider.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: ".local/subscription.json" },
    streams: { type: "string", default: "6" },
  },
});

const login: unknown = JSON.parse(await readFile(values.config, "utf8"));
if (!isLogin(login)) throw new Error(`${values.config} needs server, username and password.`);
const account = parseLogin(login);
const provider = xtreamProvider(account, { userAgent: "MrStreamer/probe" });
const redact = (text: string) =>
  text
    .replaceAll(account.password, "<password>")
    .replaceAll(encodeURIComponent(account.password), "<password>");

console.log(`Server: ${account.server}`);
const raw = await fetch(
  `${account.server}/player_api.php?${new URLSearchParams({ username: account.username, password: account.password })}`,
  { headers: { "User-Agent": "MrStreamer/probe" } },
);
console.log(
  `player_api.php: HTTP ${raw.status}, ${raw.headers.get("content-type") ?? "no content type"}`,
);
const info: unknown = await raw.json().catch(() => null);
if (
  info &&
  typeof info === "object" &&
  "user_info" in info &&
  info.user_info &&
  typeof info.user_info === "object"
) {
  const { status, exp_date, max_connections, active_cons, allowed_output_formats } =
    info.user_info as Record<string, unknown>;
  console.log("Account:", {
    status,
    exp_date,
    max_connections,
    active_cons,
    allowed_output_formats,
  });
}
if (info && typeof info === "object" && "server_info" in info) {
  const serverInfo = info.server_info as Record<string, unknown>;
  console.log("Server info:", {
    url: serverInfo["url"],
    port: serverInfo["port"],
    https_port: serverInfo["https_port"],
    protocol: serverInfo["server_protocol"],
    timezone: serverInfo["timezone"],
  });
}

console.log(`Adapter authenticate:`, await provider.authenticate());

const started = performance.now();
const catalogue = await provider.liveCatalogue();
const elapsed = Math.round(performance.now() - started);
const withLogo = catalogue.channels.filter((channel) => channel.logoUrl).length;
console.log(
  `Live catalogue: ${catalogue.channels.length} channels, ${catalogue.categories.length} categories, ` +
    `${Math.round((withLogo / Math.max(1, catalogue.channels.length)) * 100)}% with logos, fetched and parsed in ${elapsed} ms`,
);
const sizes = new Map<string, number>();
for (const channel of catalogue.channels) {
  for (const id of channel.categoryIds) sizes.set(id, (sizes.get(id) ?? 0) + 1);
}
const names = new Map(catalogue.categories.map((category) => [category.id, category.name]));
console.log("Largest categories:");
for (const [id, count] of [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(count).padStart(6)}  ${names.get(id) ?? `#${id}`}`);
}
console.log(
  "Sample names:",
  catalogue.channels
    .filter((_, index) => index % Math.ceil(catalogue.channels.length / 12) === 0)
    .map((channel) => channel.name),
);

const count = Number(values.streams);
if (count > 0) {
  const candidates = catalogue.channels.filter(
    (channel) => !/^[#=*\-_ ]{3,}|[#=*]{4,}/.test(channel.name),
  );
  const picks: ProviderChannel[] = [];
  for (
    let index = 0;
    picks.length < count && index < candidates.length;
    index += Math.ceil(candidates.length / count)
  ) {
    const pick = candidates[index];
    if (pick) picks.push(pick);
  }
  console.log(`\nProbing ${picks.length} live streams one at a time:`);
  for (const channel of picks) {
    const { url } = provider.liveStream(channel.id);
    const result = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-rw_timeout",
        "15000000",
        "-analyzeduration",
        "6000000",
        "-probesize",
        "6000000",
        "-show_entries",
        "format=format_name:stream=codec_type,codec_name,profile,width,height,avg_frame_rate,channels,sample_rate",
        "-of",
        "json",
        url,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    const streams = (output?.streams ?? []).map((stream: Record<string, unknown>) =>
      stream["codec_type"] === "video"
        ? `video ${stream["codec_name"]} ${stream["profile"] ?? ""} ${stream["width"]}x${stream["height"]} @${stream["avg_frame_rate"]}`
        : `${stream["codec_type"]} ${stream["codec_name"]} ${stream["channels"] ?? ""}ch ${stream["sample_rate"] ?? ""}`,
    );
    console.log(`- ${channel.name} [${output?.format?.format_name ?? "?"}]`);
    for (const line of streams) console.log(`    ${line.trim()}`);
    if (result.stderr?.trim())
      console.log(`    ffprobe: ${redact(result.stderr.trim().split("\n")[0] ?? "")}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

function isLogin(value: unknown): value is { server: string; username: string; password: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "server" in value &&
    typeof value.server === "string" &&
    "username" in value &&
    typeof value.username === "string" &&
    "password" in value &&
    typeof value.password === "string"
  );
}
