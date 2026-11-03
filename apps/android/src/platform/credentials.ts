import { type } from "arktype";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { requireNativeModule } from "expo";

/**
 * What signs in to a saved source: an Xtream server and login, or a playlist link, which can hold
 * a token. The native credentials module seals it with a Keystore key (modules/credentials), so
 * nothing of it reaches app storage, backups or logs, and native workers read the same JSON by
 * source id without JS. Keep this shape stable: those workers parse it too (README.md).
 */
export const Authority = type({
  kind: "'xtream'",
  server: "string",
  username: "string",
  password: "string",
}).or({ kind: "'m3u'", link: "string" });

export type Authority = typeof Authority.infer;

/** Protected authorities by source id. Every failure is `keychain-refused`. */
export interface Credentials {
  /** The authority saved for `id`, null when none is or it isn't of a shape this build knows. */
  read(id: string): Promise<Authority | null>;
  write(id: string, authority: Authority): Promise<void>;
  remove(id: string): Promise<void>;
  /** Removes every authority whose id isn't in `ids`. */
  retain(ids: readonly string[]): Promise<void>;
}

interface NativeCredentials {
  read(id: string): Promise<string | null>;
  write(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
  retain(ids: readonly string[]): Promise<void>;
}

async function refusedOnFailure<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation();
  } catch {
    throw new AppFailure({ kind: "keychain-refused" });
  }
}

/** The Keystore-sealed credentials of this install. */
export function nativeCredentials(
  native: NativeCredentials = requireNativeModule<NativeCredentials>("Credentials"),
): Credentials {
  return {
    read: (id) =>
      refusedOnFailure(async () => {
        const sealed = await native.read(id);

        if (sealed === null) return null;
        const parsed = Authority(JSON.parse(sealed));

        return parsed instanceof type.errors ? null : parsed;
      }),
    write: (id, authority) => refusedOnFailure(() => native.write(id, JSON.stringify(authority))),
    remove: (id) => refusedOnFailure(() => native.remove(id)),
    retain: (ids) => refusedOnFailure(() => native.retain(ids)),
  };
}
