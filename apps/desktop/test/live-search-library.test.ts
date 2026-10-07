import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import { groupLiveSearch } from "@mrstreamer/core/catalogue/search";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

async function started(dataDir: string) {
  const runtime = runtimeFor(
    Library.layer({ confirmDelay: 0 }).pipe(
      Layer.provideMerge(Settings.layer(dataDir)),
      Layer.provideMerge(
        Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
      ),
    ),
  );
  return {
    library: await promised(runtime, Library),
    subscriptions: await promised(runtime, Subscriptions),
  };
}

it("search keeps every provider/category/quality copy and reconstructs safe metadata from unchanged raw caches", async () => {
  const providers = [await fakeProvider(), await fakeProvider()];
  for (const provider of providers) {
    const categories = provider.catalogue.categories.filter((category) =>
      category.name.startsWith("BE |"),
    );
    provider.serveChannels((channels) =>
      channels.slice(0, 5).map((channel, index) => ({
        ...channel,
        name: [
          "BE | VRT 1 FHD",
          "BE | VRT 1 HD",
          "BE | VRT 1 SD",
          "BE | VRT CANVAS FHD",
          "BE | VRT CANVAS HD",
        ][index]!,
        categoryId: categories[index === 2 || index === 4 ? 1 : 0]!.id,
        guideId: index < 3 ? "VRT1.be" : "VRTCanvas.be",
        adult: false,
      })),
    );
  }
  const dataDir = await tempDir();
  const { library, subscriptions } = await started(dataDir);
  const ids = [];
  for (const provider of providers) {
    const subscription = await subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    ids.push(subscription.id);
    await library.refresh(subscription.id);
  }
  const ordinary = await library.channels({});
  expect(ordinary).toHaveLength(8);
  const results = await library.channels({ query: "VRT" });
  expect(results).toHaveLength(8);
  expect(groupLiveSearch(results).map((group) => [group.copies.length, group.streams])).toEqual([
    [4, 6],
    [4, 4],
  ]);
  const qualityMatches = await library.channels({ query: "FHD" });
  expect(qualityMatches).toHaveLength(8);
  const programmeMatches = await library.channels({
    query: "evening news",
    channels: [{ subscriptionId: ids[1]!, id: "1002" }],
  });
  expect(
    groupLiveSearch(programmeMatches).map((group) => [group.copies.length, group.streams]),
  ).toEqual([[4, 6]]);
  for (const channel of results) expect(await library.channel(channel)).toEqual(channel);
  const cached = type({ version: "4", channels: type({ "searchIdentity?": "undefined" }).array() })(
    JSON.parse(await readFile(join(dataDir, "catalogue.json"), "utf8")),
  );
  expect(cached).not.toBeInstanceOf(type.errors);
  await Promise.all(providers.map((provider) => provider.close()));
  const restart = await started(dataDir);
  expect(await restart.library.channels({ query: "VRT" })).toEqual(results);
  expect(await restart.library.channels({})).toEqual(ordinary);
  expect((await restart.library.status()).map((status) => status.subscriptionId)).toEqual(ids);
});
