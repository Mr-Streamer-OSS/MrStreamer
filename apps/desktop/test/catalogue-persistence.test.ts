import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, inject, it } from "vitest";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import type {
  CatalogueOwner,
  WorkerCalls,
  WorkerReply,
  WorkerSetup,
} from "../src/main/ondemand/protocol.ts";
import { tempDir } from "./support.ts";

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

function start(dir: string) {
  const worker = new Worker(
    inject("catalogueWorker") ??
      new URL("../src/main/ondemand/catalogue-worker.ts", import.meta.url),
    {
      workerData: {
        metadataPath: join(dir, "metadata.json.gz"),
        userAgent: "test",
        tmdb: null,
      } satisfies WorkerSetup,
    },
  );
  workers.push(worker);
  let sequence = 0;
  function call<M extends keyof WorkerCalls>(
    method: M,
    args: WorkerCalls[M]["args"],
  ): Promise<WorkerCalls[M]["result"]> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const receive = (reply: WorkerReply) => {
        if (reply.id !== id) return;
        worker.off("message", receive);
        if (reply.ok) resolve(reply.value as WorkerCalls[M]["result"]);
        else reject(reply.error);
      };
      worker.on("message", receive);
      worker.postMessage({ id, method, args, interfaceLanguage: "en" });
    });
  }
  const owner: CatalogueOwner = { subscriptionId: "saved", key: "account", dir };
  return {
    call,
    owner,
    async accept(name: string, revision: number) {
      const catalogue: OnDemandCatalogue = {
        movieCategories: [],
        seriesCategories: [],
        series: [],
        movies: [
          {
            id: "1",
            name,
            posterUrl: null,
            backdropUrl: null,
            rating: null,
            addedAt: 1,
            releaseDate: null,
            categoryIds: [],
            adult: false,
            container: "mkv",
          },
        ],
      };
      await call("refresh", {
        ...owner,
        revision,
        catalogue,
        account: { kind: "m3u", link: "http://unused.test/list" },
      });
      await call("finishRefresh", { ...owner, revision, keep: true });
    },
    async names() {
      const result = await call("byIds", {
        owners: [owner],
        language: "en",
        kind: "movie",
        versions: [{ subscriptionId: owner.subscriptionId, id: "1" }],
      });
      return result.map((title) => title.title);
    },
    stop: () => worker.terminate(),
  };
}

describe("accepted catalogue persistence", () => {
  it("retries a failed write on flush and reloads the accepted lists without a provider", async () => {
    const dir = await tempDir();
    const path = join(dir, "ondemand.json.gz");
    const app = start(dir);
    await app.accept("Previous", 1);
    await app.call("flush", {});
    // A directory at the atomic rename destination makes the next write fail on every platform.
    await rm(path);
    await mkdir(path);
    await app.accept("Latest", 2);
    await app.call("flush", {});
    expect((await stat(path)).isDirectory()).toBe(true);
    await rm(path, { recursive: true });
    await app.call("flush", {});
    await app.stop();
    expect(await start(dir).names()).toEqual(["Latest"]);
  });

  it("keeps only the newest replacement while a failed snapshot waits", async () => {
    const dir = await tempDir();
    const path = join(dir, "ondemand.json.gz");
    const app = start(dir);
    await app.accept("Superseded", 1);
    await mkdir(path);
    await app.call("flush", {});
    await app.accept("Replacement", 2);
    await rm(path, { recursive: true });
    await Promise.all([app.call("flush", {}), app.call("flush", {})]);
    await app.stop();
    expect(await start(dir).names()).toEqual(["Replacement"]);
  });

  it("forgets a failed snapshot so a later flush cannot resurrect it", async () => {
    const dir = await tempDir();
    const path = join(dir, "ondemand.json.gz");
    const app = start(dir);
    await app.accept("Removed", 1);
    await mkdir(path);
    await app.call("flush", {});
    await rm(path, { recursive: true });
    await app.call("forget", app.owner);
    await app.call("flush", {});
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await app.names()).toEqual([]);
  });

  it("settles repeated persistent write failures within the existing shutdown allowance", async () => {
    const dir = await tempDir();
    const app = start(dir);
    await app.accept("Accepted", 1);
    await mkdir(join(dir, "ondemand.json.gz"));
    const began = performance.now();
    await app.call("flush", {});
    await app.call("flush", {});
    expect(performance.now() - began).toBeLessThan(2000);
    expect(await app.names()).toEqual(["Accepted"]);
  });
});
