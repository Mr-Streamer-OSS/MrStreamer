// The two kinds of subscription: an Xtream Codes login, or a playlist link without one.
// `parseLogin` (./xtream.ts) tells them apart from what the user typed.
import type { Provider, ProviderOptions } from "@mrstreamer/core/provider";
import { playlistProvider } from "./m3u.ts";
import { xtreamProvider, type ParsedLogin } from "./xtream.ts";

export type ProviderAccount = ParsedLogin["account"];

export function providerFor(account: ProviderAccount, options: ProviderOptions): Provider {
  return account.kind === "xtream"
    ? xtreamProvider(account, options)
    : playlistProvider(account, options);
}
