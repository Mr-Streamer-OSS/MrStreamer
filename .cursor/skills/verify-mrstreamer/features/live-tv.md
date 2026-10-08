# Live TV

## Sub-features

Pick channels through global search, Live TV, guide or favourites. Watch shares its live stream with the muted Home preview. Other paths include codec conversion, captions, recovery and favourite ordering.

## How to get to it (user POV)

After connecting, **Search** or Ctrl-K/Cmd-K finds channels and programmes. Enter starts the selected channel. **Live TV** provides channel/category and guide browsing. Escape leaves Watch for Home; **Watch** returns to the current channel. Favourites are saved from channel controls and appear on Home and Live TV.

## Driving it with Electron CDP

Preconditions: `pnpm build`, a display and the fake provider's `h264-aac.mpegts` fixture. Run `pnpm verify:desktop live-tv`. Search `TEST | H.264 + AAC`, press Enter and observe Watch, an advancing video clock, nonzero picture width and decoded audio bytes. Press Escape and observe a playing, muted Home preview. Click Watch and observe unmuted playback, exactly one active provider connection and zero extra stream requests. Retain screenshots of the connected app, Watch, Home preview and final Watch.

For converted codecs, titles and subtitle rendering use `apps/desktop/test/e2e/packaged-app.ts`; recovery uses `live-recovery-app.ts`; favourites use `favourite-order.ts`; external guide settings use `guide-source.ts`. Follow their documented executable arguments and capture the affected entry point, not only global search.

Source: `docs/user/live-tv.md`, `apps/desktop/src/renderer/src/player/`, `apps/desktop/test/e2e/packaged-app.ts`.

## Gotchas

Only the synthetic codec-test channels play media. A final frame can conceal stopped playback; require clock progress and decoded sound. Home deliberately keeps the stream running. Linux Xvfb proves functional decoding only; audible sound, GPU use, real streams and AirPlay/Cast remain separate checks.
