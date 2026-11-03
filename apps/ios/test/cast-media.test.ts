import { describe, expect, it } from "vitest";
import { rewritePlaylist, type RouteKind } from "../src/cast-media.ts";

// What a TV is given of a stream: playlists rewritten so every address it reads is the relay's,
// keys refused, sound narrowed to the chosen track, and the first profile's limits.

const PROVIDER = "http://provider.example:8080/live/user/secret/1.m3u8";

/** Rewrites `text`, numbering each relayed URI and keeping what each stands for. */
function rewrite(text: string, sound: string | null = null) {
  const routes: Array<{ url: string; kind: RouteKind }> = [];
  const result = rewritePlaylist(
    text,
    PROVIDER,
    (url, kind) => {
      routes.push({ url, kind });
      return `${routes.length}.${kind === "playlist" ? "m3u8" : "ts"}`;
    },
    sound,
  );
  return { result, routes };
}

describe("rewritePlaylist", () => {
  it("names no provider address: segments and keys-free maps go through the relay", () => {
    const { result, routes } = rewrite(
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:6",
        '#EXT-X-MAP:URI="init.mp4"',
        "#EXTINF:6,",
        "seg1.m4s?token=abc",
        "#EXTINF:6,",
        "http://cdn.example/seg2.m4s",
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part.m4s"',
      ].join("\n"),
    );
    expect(result.kind).toBe("playlist");
    if (result.kind !== "playlist") return;
    expect(result.text).not.toMatch(/provider|cdn|secret|token=|part\.m4s/);
    expect(result.text).toContain('#EXT-X-MAP:URI="1.ts"');
    expect(result.segments).toBe("fmp4");
    expect(routes).toEqual([
      { url: "http://provider.example:8080/live/user/secret/init.mp4", kind: "media" },
      { url: "http://provider.example:8080/live/user/secret/seg1.m4s?token=abc", kind: "media" },
      { url: "http://cdn.example/seg2.m4s", kind: "media" },
    ]);
  });

  it("refuses a stream with a key, wherever it appears", () => {
    const keyed = (key: string) =>
      rewrite(["#EXTM3U", "#EXTINF:6,", "a.ts", key, "#EXTINF:6,", "b.ts"].join("\n")).result;
    expect(keyed('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k"')).toEqual({
      kind: "refused",
      refusal: "protected",
    });
    expect(keyed('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="k"').kind).toBe("refused");
    expect(keyed("#EXT-X-KEY:METHOD=NONE").kind).toBe("playlist");
  });

  it("keeps only the chosen sound and no subtitles in a title's master playlist", () => {
    const { result } = rewrite(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English 1",LANGUAGE="eng",DEFAULT=YES,URI="a0.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Nederlands 2",LANGUAGE="dut",DEFAULT=NO,URI="a1.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English 1",URI="s0.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"',
        "v.m3u8",
      ].join("\n"),
      "nl",
    );
    if (result.kind !== "playlist") throw new Error(result.kind);
    expect(result.text).toContain("Nederlands 2");
    expect(result.text).not.toContain("English 1");
    expect(result.text).not.toMatch(/SUBTITLES/);
    expect(result.variant).toMatch(/\.m3u8$/);
  });

  it("refuses a stream whose every variant is outside the first profile", () => {
    const only = (codecs: string, resolution = "1920x1080") =>
      rewrite(
        [
          "#EXTM3U",
          `#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="${codecs}",RESOLUTION=${resolution}`,
          "v.m3u8",
        ].join("\n"),
      ).result;
    expect(only("hvc1.1.6.L120.90,mp4a.40.2")).toEqual({ kind: "refused", refusal: "codec" });
    expect(only("avc1.640028,ac-3")).toEqual({ kind: "refused", refusal: "codec" });
    expect(only("avc1.640033,mp4a.40.2")).toEqual({ kind: "refused", refusal: "codec" });
    expect(only("avc1.640028,mp4a.40.2", "3840x2160")).toEqual({
      kind: "refused",
      refusal: "codec",
    });
    // A file with an AAC track beside an AC-3 one still goes, naming only what the TV plays.
    const mixed = only("avc1.640028,mp4a.40.2,ac-3");
    expect(mixed.kind === "playlist" && mixed.text).toContain('CODECS="avc1.640028,mp4a.40.2"');
  });

  it("refuses what isn't a playlist", () => {
    expect(rewrite("<html>login</html>").result).toEqual({ kind: "refused", refusal: "stream" });
  });
});
