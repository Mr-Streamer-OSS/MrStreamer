import { isCallable } from "../../../../../packages/contracts/src/callable.ts";
import { type Observed, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "runtime globals",
    compare: "record",
    run: () => {
      const zone = (() => {
        try {
          return new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
          }).format(0);
        } catch (error) {
          return error instanceof Error ? error.name : "failed";
        }
      })();

      const scope = globalThis;
      const crypto = "crypto" in scope ? scope.crypto : undefined;

      return {
        Buffer: "Buffer" in scope && scope.Buffer !== undefined,
        TextEncoder: "TextEncoder" in scope && scope.TextEncoder !== undefined,
        TextDecoder: "TextDecoder" in scope && scope.TextDecoder !== undefined,
        ReadableStream: "ReadableStream" in scope && scope.ReadableStream !== undefined,
        structuredClone: "structuredClone" in scope && scope.structuredClone !== undefined,
        setImmediate: "setImmediate" in scope && scope.setImmediate !== undefined,
        cryptoRandomUUID: crypto?.randomUUID !== undefined,
        cryptoSubtle: crypto?.subtle !== undefined,
        AbortSignalTimeout: "timeout" in AbortSignal,
        AbortSignalAny: "any" in AbortSignal,
        PromiseWithResolvers: isCallable(Promise.withResolvers),
        MapGroupBy: isCallable(Map.groupBy),
        ArrayToSorted: isCallable(Array.prototype.toSorted),
        IntlDisplayNames: Intl.DisplayNames !== undefined,
        IntlListFormat: Intl.ListFormat !== undefined,
        IntlPluralRules: Intl.PluralRules !== undefined,
        IntlLocale: Intl.Locale !== undefined,
        IntlCollator: Intl.Collator !== undefined,
        timeZoneKolkataMidnightUtc: zone,
        normalizeNfd: "é".normalize("NFD").length,
      };
    },
  },
  {
    name: "URL: WHATWG parsing the shared rules rely on",
    compare: "same",
    run: () => {
      const attempt = (make: () => URL): Observed => {
        try {
          const url = make();

          return [url.href, url.origin, url.pathname, url.search, url.username, url.password];
        } catch (error) {
          return error instanceof Error ? error.name : "failed";
        }
      };

      return {
        canParse: isCallable(URL.canParse),
        parse: isCallable(URL.parse),
        relative: attempt(() => new URL("../ok?a=1", "http://line.test:8080/live/user/pass/1.ts")),
        absolutePath: attempt(() => new URL("/ok", "https://line.test/player_api.php?x=1")),
        otherHost: attempt(() => new URL("http://cdn.test/a b", "https://line.test/")),
        credentials: attempt(() => new URL("http://us%40er:p%3Ass@line.test:80/get.php")),
        uppercase: attempt(() => new URL("HTTP://LINE.Test/Path")),
        notAUrl: attempt(() => new URL("line.test without scheme")),
        rtmp: attempt(() => new URL("rtmp://echo.test/live")),
        params: (() => {
          const url = new URL("http://line.test/get.php?username=a%20b&password=x%26y");

          return [url.searchParams.get("username"), url.searchParams.get("password")];
        })(),
      };
    },
  },
];
