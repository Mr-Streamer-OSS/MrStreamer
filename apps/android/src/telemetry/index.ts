import { build } from "../settings/build.ts";
import { preferences } from "../platform/preferences.ts";
import { androidAnalytics } from "./analytics.ts";
import { analyticsTransport } from "./transport.ts";
import { androidBuild } from "./model.ts";

const files = preferences();

export const statistics = androidAnalytics({
  load: () => files.read("statistics.json"),
  save: (record) => files.write("statistics.json", record),
  revocation: {
    load: () => {
      const value = files.read("statistics-revocation.json");

      if (value !== null && typeof value !== "boolean") throw new Error("Revocation unavailable");

      return value === true;
    },
    save: (pending) => files.write("statistics-revocation.json", pending),
  },
  uuid: () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (letter) => {
      const random = Math.floor(Math.random() * 16);

      return (letter === "x" ? random : (random & 3) | 8).toString(16);
    }),
  build: androidBuild(build.release, build.version, build.code),
  transport: analyticsTransport({
    development: __DEV__,
    releaseBuild: process.env.EXPO_PUBLIC_MR_STREAMER_ANALYTICS_RELEASE_BUILD,
    host: process.env.EXPO_PUBLIC_MR_STREAMER_ANALYTICS_HOST,
    projectToken: process.env.EXPO_PUBLIC_MR_STREAMER_ANALYTICS_PROJECT_TOKEN,
    localEndpoint: process.env.EXPO_PUBLIC_MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT,
  }),
});
