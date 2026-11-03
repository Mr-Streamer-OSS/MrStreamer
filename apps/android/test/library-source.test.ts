import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sourcesOwner } from "../src/connect/sources.ts";
import type { Authority } from "../src/platform/credentials.ts";
import { fixture } from "./library-fixture.ts";

it.each(["removed", "replaced", "read again"])(
  "drops an on-demand answer for a source %s during its read",
  async (change) => {
    const f = fixture();
    let release = () => {};

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let started = () => {};

    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });

    let block = false;
    const authorities = new Map<string, Authority>();

    const owner = sourcesOwner({
      credentials: {
        read: async (id) => authorities.get(id) ?? null,
        write: async (id, value) => {
          authorities.set(id, value);
        },
        remove: async (id) => {
          authorities.delete(id);
        },
        retain: async () => {},
      },
      readJson: () => null,
      writeJson: () => {},
      userAgent: "test",
      fetch: async (input, init) => {
        if (block && new URL(String(input)).searchParams.get("action") === "get_vod_streams") {
          block = false;
          started();
          await held;
        }

        return f.fetchImpl(input, init);
      },
    });

    await owner.restore();

    const login = {
      server: "https://provider.invalid",
      username: randomUUID(),
      password: randomUUID(),
    };

    const connected = await owner.connect(login);

    if (connected.kind !== "connected") throw new Error("Fake provider did not connect");
    const reader = owner.onDemand(connected.id);
    expect(reader).not.toBeNull();
    block = true;
    const answer = reader!.onDemandCatalogue();
    // Attach the rejection before revocation aborts the real adapter's signal.
    const rejected = expect(answer).rejects.toBeDefined();
    await pending;

    if (change === "removed") await owner.remove(connected.id);
    else if (change === "replaced") await owner.connect({ ...login, password: randomUUID() });
    else await reader!.onDemandCatalogue();
    release();
    await rejected;

    if (change === "removed") expect(owner.onDemand(connected.id)).toBeNull();
    else expect((await owner.onDemand(connected.id)!.onDemandCatalogue()).movies).toHaveLength(43);
  },
);
