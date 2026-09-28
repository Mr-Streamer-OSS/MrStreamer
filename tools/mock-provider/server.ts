// Runs the mock provider for local development.
// Usage: pnpm mock:provider [--port 7811] [--channels 12000] [--max-connections 1] [--null-streams]
// Then connect the app to the printed server with username "demo" and password "demo".
import { parseArgs } from "node:util";
import { startMockProvider } from "./app.ts";
import { ffmpegSource, hasFfmpeg, nullPacketSource } from "./streams.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "7811" },
    host: { type: "string", default: "127.0.0.1" },
    channels: { type: "string", default: "12000" },
    "max-connections": { type: "string", default: "1" },
    "null-streams": { type: "boolean", default: false },
  },
});

const useFfmpeg = !values["null-streams"];
if (useFfmpeg && !hasFfmpeg()) {
  console.error(
    "ffmpeg was not found on PATH. Install it (brew install ffmpeg) or pass --null-streams.",
  );
  process.exit(1);
}

const provider = await startMockProvider({
  streams: useFfmpeg ? ffmpegSource() : nullPacketSource(),
  port: Number(values.port),
  host: values.host,
  channels: Number(values.channels),
  maxConnections: Number(values["max-connections"]),
  log: (line) => console.log(`[mock] ${line}`),
});

console.log(`Mock Xtream provider on ${provider.url}`);
console.log(`Login: ${provider.username} / ${provider.password}`);
console.log(
  `${provider.catalogue.channels.length} channels in ${provider.catalogue.categories.length} categories`,
);
