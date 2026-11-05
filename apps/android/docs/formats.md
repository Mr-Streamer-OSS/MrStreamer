# Android format qualification

Android 0.1.0 has one Media3 owner. Decoder inventory and renderer track support are declarations, not observed picture or sound. No native format extension is included by this work. Every row below is **unqualified on an installed Android candidate** until an Evidence run records its outcome. A refusal is a result, not delivered parity.

## Named file matrix

The parity rows come from `docs/contributing/testing.md` and the repository fixture directories. Codec names below are ffprobe inventory, not Android decoding. Each file appears as a movie named `parity/<file>`, `codecs/<file>` or `native/<file>` in the qualification panel.

| Fixture                                | Declared streams                                           |
| -------------------------------------- | ---------------------------------------------------------- |
| parity/mpeg2-mp2.mpegts                | mpeg2video Main, mp2                                       |
| parity/recording-long-subtitles.mpegts | h264 High, dvb_subtitle, dvb_teletext                      |
| parity/title-av1-10bit.mkv             | av1 Main, eac3, aac LC, subrip, subrip                     |
| parity/title-caption-track.mov         | h264 High, eia_608                                         |
| parity/title-h264-10bit.mkv            | h264 High 10, aac LC, aac LC, subrip, subrip               |
| parity/title-h264-aac.mp4              | h264 High, aac LC, mov_text                                |
| parity/title-h264-eac3-subs.mkv        | h264 High, eac3, aac LC, subrip, subrip                    |
| parity/title-h264-picture-subs.mkv     | h264 High, aac LC, hdmv_pgs_subtitle, dvd_subtitle, subrip |
| parity/title-hevc-12bit.mkv            | hevc Rext, aac LC, aac LC, subrip, subrip                  |
| parity/title-long-av1-10bit.mkv        | av1 Main, flac, hdmv_pgs_subtitle, dvd_subtitle, subrip    |
| parity/title-long-subs-doubled.mkv     | h264 High, flac, hdmv_pgs_subtitle, dvd_subtitle, subrip   |
| parity/title-long-subs-uncued.mkv      | h264 High, flac, hdmv_pgs_subtitle, dvd_subtitle, subrip   |
| parity/title-long-subs.mkv             | h264 High, flac, hdmv_pgs_subtitle, dvd_subtitle, subrip   |
| parity/title-mpeg4-mp3.avi             | mpeg4 Simple Profile, mp3                                  |
| parity/title-receiver.mkv              | h264 High, aac LC, aac LC, subrip                          |
| parity/title-receiver.mp4              | h264 High, aac LC, aac LC, mov_text                        |
| parity/h264-aac.mpegts                 | h264 High, aac LC                                          |
| parity/h264-ac3-dvb.mpegts             | h264 High, ac3                                             |
| parity/h264-ac3.mpegts                 | h264 High, ac3                                             |
| parity/h264-damaged.mpegts             | h264 High, aac LC                                          |
| parity/h264-eac3.mpegts                | h264 High, eac3                                            |
| parity/h264-mp2.mpegts                 | h264 High, mp2                                             |
| parity/h264-mp3.mpegts                 | h264 High, mp3                                             |
| parity/h264-open-gop-joined.mpegts     | h264 High, aac LC                                          |
| parity/h264-subtitles.mpegts           | h264 High, aac LC, aac LC, dvb_subtitle, dvb_teletext      |
| parity/hevc-aac.mpegts                 | hevc Main, aac LC                                          |
| parity/hevc10-aac.mpegts               | hevc Main 10, aac LC                                       |
| parity/hls-epoch-0.mpegts              | mpeg2video Main, ac3, ac3, dvb_subtitle, dvb_teletext      |
| parity/hls-epoch-1.mpegts              | h264 High, ac3, ac3, dvb_subtitle, dvb_teletext            |
| codecs/av1-10bit.mkv                   | av1 Main                                                   |
| codecs/av1-10bit.mp4                   | av1 Main                                                   |
| codecs/vp8.webm                        | vp8 0                                                      |
| codecs/vp9-10bit.mp4                   | vp9 Profile 2                                              |
| codecs/vp9-10bit.webm                  | vp9 Profile 2                                              |
| native/h264-aac.m2ts                   | h264 High, aac LC                                          |
| native/h264-aac.mp4                    | h264 High, aac LC                                          |
| native/hevc-ac3-eac3-srt.mkv           | hevc Main, ac3, eac3, subrip                               |
| native/hevc10-eac3.mp4                 | hevc Main 10, eac3                                         |
| native/mpeg2-mp2.m2ts                  | mpeg2video Main, mp2                                       |
| native/not-media.bin                   | invalid bytes (expect format failure)                      |
| native/vp9-opus.webm                   | vp9 Profile 0, opus                                        |

The native HLS movies are `native/hls/index.m3u8`, `native/hls/event.m3u8`, `native/hls-ladder/index.m3u8` and its `native/hls-ladder/v0/index.m3u8` and `native/hls-ladder/v1/index.m3u8` renditions. They carry silent H.264/AAC and stay on the same fixture origin.

## Installed qualification procedure

Build on forge after frozen installs at the root and in the Android app:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/android install --frozen-lockfile
cd apps/android/android
fleet-android gradle :player:testDebugUnitTest assembleRelease
```

Only Evidence opens the shared `Pixel_9_API_37` x86_64 emulator on forge's device host `local`. Call `device_list`, then `device_open` with that host and device id; wait if another agent owns the session. Follow the returned `quickStart` and use its exact AgentDevice command for app launch and all UI input, screenshots and recordings. From the same Gradle directory, install that exact release APK:

```sh
fleet-android install app/build/outputs/apk/release/app-release.apk
```

The install prints `Success`. The release carries its JavaScript bundle and needs no Metro. Its native code must include x86_64; the project configures `arm64-v8a,x86_64`. Confirm the expected app state with `device_screenshot`. Record its source SHA, APK hash, package/version and device/API/ABI. If available through the approved device workflow, record the platform media codec inventory; the release UI does not expose `capabilities()`. Keep installed, physical device, receiver and store results separate. Source and JVM checks do not qualify decoding.

Start the named-file panel from the repository root, with Node 24+, ffmpeg and ffprobe:

```sh
FIXTURE_OUT="$PWD/.local/699/formats-ranges" node apps/android/test/formats-server.ts 8891 8892
```

Both ports bind loopback on forge. In another shell on forge, Evidence forwards only the provider port directly to its owned emulator:

```sh
$ANDROID_HOME/platform-tools/adb -s emulator-5554 reverse tcp:8891 tcp:8891
```

Use the serial of the managed device if it differs from `emulator-5554`. Keep control port 8892 on forge. Connect the installed app to `http://127.0.0.1:8891` as `fixture` / `fixture-pass`. Movies lists each named row; Live's TEST category supplies silent copies of the TS channel clips. Use normal UI input through Connect, Movies, Live and Watch. This exercises the production source resolver, admission, app-side header construction, holds, one native owner and track controls. The fixture proxy forwards Range only, so it does not qualify upstream receipt of private headers. Do not invoke a second player or treat the HTTP test as installed proof.

Stop this server with SIGINT, then repeat on a fresh isolated app profile:

```sh
FIXTURE_OUT="$PWD/.local/699/formats-whole" node apps/android/test/formats-server.ts 8891 8892 --no-ranges
```

Every title file must be qualified with ranges and without them, including seek before/after subtitles and the MP4 index at the end. A backend redirect remains on the forwarded provider origin. The panel allows 64 simultaneous responses so seek/reconnect overlap does not become a synthetic single-slot refusal. Active proxy responses remain observable; this is not a provider-capacity test.

The server defaults to silent sound in the same codecs/tracks and preserves subtitle dispositions. ffmpeg remuxing can shift timestamps and rewrite indexes: `provenance.json` identifies exact served copies. Use `FIXTURE_SOUND=1` only for a bounded sound test under the host's sound rules. That serves repository originals byte for byte. The long/uncued/doubled subtitle fixtures are already silent and remain byte-identical in the default pass. Rows recorded as `silent-*`, including the index-at-end MP4 and EAC3/picture-subtitle MKVs, need the original pass to qualify their original mux/index behavior. The generated network source stays silent in both passes. No host volume/settings changes. Generated damaged and joined TS may print ffmpeg warnings; those are fixture conditions, not Android results.

### HLS and catch-up rows

Reuse the existing mobile fixture for HLS, not its iOS player. Run from the root:

```sh
FIXTURE_OUT="$PWD/.local/699/hls" node apps/ios/scripts/fixture-server.ts 8791 8792
```

Forward this server's provider port directly on forge as well:

```sh
$ANDROID_HOME/platform-tools/adb -s emulator-5554 reverse tcp:8791 tcp:8791
```

Keep control port 8792 on forge. Its fake Xtream panel is reached at `http://127.0.0.1:8791` with the same fixture login. Android normally resolves Xtream Live to TS. To exercise actual HLS, connect a separate M3U source pointing to a file on an owned fixture HTTP host. Each entry must name the forwarded fixture's `/live/fixture/fixture-pass/<id>.m3u8`, including stream 7999. Record the exact generated M3U under `.local/699/`. The fixture control `/live` and request log must show playlist/segment reads; a `.ts` request does not qualify HLS. Remove that source after testing. The native HLS playlists are also named movies on the formats panel; their variants and segments stay on its provider origin, so normal Movies → Watch can qualify title/seek behavior.

| Named route                               | Required observations                                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEST H.264/AAC and HEVC/AAC Live HLS      | moving picture, silent default; bounded sound pass; replacement/close                                                                                                        |
| TEST subtitle channel HLS                 | distinguish captions in video from DVB/teletext absent from the HLS remux                                                                                                    |
| 7999 Live sound and subtitles EN/NL       | both audio selections, WebVTT cue rendering, Off, language; list-only does not pass                                                                                          |
| Native hls/index.m3u8                     | finite VOD playlist, ending and seeking; named movie on the formats panel; installed outcome unqualified                                                                     |
| Native hls/event.m3u8                     | event playlist without ENDLIST; end is bounded archive end, not perpetual Live                                                                                               |
| Native hls-ladder/index.m3u8              | both video renditions and Automatic, picture after switching; named movie on the formats panel; installed outcome unqualified                                                |
| Xtream H.264/AAC and HEVC/AAC TS catch-up | Guide programme → Watch, finite archive, seek/resume, correct programme/start/duration; formats panel serves a silent finite clip                                            |
| Xtream HLS catch-up                       | explicit `.m3u8` request, finite recording despite no ENDLIST, end/seek/release; Android's normal TS route does not qualify this                                             |
| Flussonic playlist catch-up               | use `apps/desktop/test/fake-playlist.ts` with catchup enabled, four parts without ENDLIST, Guide → programme → archive; requires a separate fixture launch, unqualified here |

Two additional desktop HLS journeys remain explicitly **unqualified** and are not served by this panel: alternate-language audio (including `spa`), English/German WebVTT and empty French WebVTT in `apps/desktop/test/fixtures/hls`, and the MPEG-2/H.264 discontinuity, token redirect and 720p MP3 rendition in `apps/desktop/test/fake-hls.ts`. Standalone epoch TS titles do not exercise an HLS codec switch. Repeatable preparation from the repository root:

```sh
mkdir -p .local/699
cat > .local/699/desktop-hls.ts <<'SCRIPT'
import {startFakePlaylist} from '../../apps/desktop/test/fake-playlist.ts';
import {startFakeHls} from '../../apps/desktop/test/fake-hls.ts';
const playlist = await startFakePlaylist({catchup: true});
const hls = await startFakeHls({tokens: true, qualities: ['hd', 'sd', 'uhd']});
console.log({playlist, hls});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await playlist.close(); await hls.close();
});
SCRIPT
node .local/699/desktop-hls.ts
```

Keep the printed synthetic addresses local. These helpers bind ephemeral loopback ports: forward their owned ports and connect an M3U source through normal UI, retaining playlist/segment requests and track/codec-switch results. Before a host run, prepare silent copies with provenance or obtain the bounded sound pass. No Android reachability, silence or installed qualification is asserted for these two helpers.

No silent default is asserted for the separate desktop fake-playlist fixture. Evidence must mute its own test playback or prepare silent copies with provenance before using it. Fixtures and app routes that are not reachable remain explicit qualification gaps; do not replace them with direct extractor reads.

### Per-row record

Record moving picture, observed sound (or silent-default only), selected decoder if obtainable, supported/unsupported tracks, language/forced flags, actual cue/picture rendering and timing, Off, track switching, position before/after seek, pause/resume, ending and release. For long subtitles seek into an already-active cue at 12, 24, 61, 122 and 131 seconds, then test later cue delivery. Check broadcast teletext page 888, DVB, embedded CEA captions and the separate MOV caption track individually. Missing teletext/DVD/caption support is an unsupported result until demonstrated otherwise. Test AVC 10-bit, HEVC Main10/12-bit, AV1 10-bit, VP8/VP9 8/10-bit and MPEG-4 Part 2 individually; a declared codec does not qualify a profile.

For representative movie/episode rows, download and replay the exact saved copy with networking disabled, preserving #694's subtitle binding and offline-next/read holds. Close/replacement must settle connections or file holds through the production owner; downloads in use must remain protected. Exercise PiP enter/return/dismiss and track choice without creating another owner. A matrix row fails qualification when picture or selected sound is missing even if the clock advances. Record format/decoder refusal separately from HTTP, missing-file and network failures. Keep provider URLs, tokens and credentials out of evidence; only synthetic fixture identity is shareable.

The short codec-parity Live clips end after about three seconds. The player reports this expected fixture EOF as `network` / `STREAM_ENDED`; record picture, sound and tracks before it, and distinguish the log's `exhausted=true` from an injected network fault. Use continuing channel 7998 for recovery measurements.

### Network measurements

The named-file server controls **current and future media response bodies**, while metadata stays unpaced. `startupMs` is sampled per request before response headers; `kbps` and `stalled` are read during each body. Pacing is per response in chunks of at most 100 ms of configured bandwidth, not an aggregate bandwidth guarantee or latency/jitter simulator. A stall cannot retract bytes already buffered by Media3 or the HTTP stack. Use `network/continuing.mpegts` for the title measurement and Live channel 7998, TEST | Network continuing silent TS, for Live. Both use a freshly generated five-minute continuous H.264/AAC timeline, about 1200 kbps including TS padding, not a loop of reset timestamps. `session.json` records probed duration, media bitrate and bytes; `provenance.json` records the lavfi sources, encoder command and hashes. All original named codec files and channels remain present. Other Live clips are short finite parity inputs, not network recovery sources.

Only the network/continuing.mpegts measurement title is paced at 1500 kbps when `kbps=0`, preventing the entire title from arriving before the control action; Live is produced at real-time rate. This ceiling permits filling/recovery above the 1200 kbps media rate. At 256 kbps delivery is below consumption. Begin each run with a fresh playback attempt, allow initial buffering, then stall while the request remains active, wait for observed starvation, clear, and observe recovery before the five-minute source end. Bound each installed trial to four minutes from opening. If the source exhausts, discard that recovery trial and repeat; never attribute EOF to injected starvation. Events distinguish response completion from source exhaustion (a completed partial range is not source exhaustion) and client cancellation. A stall cannot retract socket/player buffers, so record how much arrived and any timeout rather than assuming an immediate transition.

```sh
curl -fsS -X POST 'http://127.0.0.1:8892/link?startupMs=1500&kbps=256&stalled=false'
curl -fsS 'http://127.0.0.1:8892/state'
curl -fsS -X POST 'http://127.0.0.1:8892/link?startupMs=0&kbps=256&stalled=true'
curl -fsS -X POST 'http://127.0.0.1:8892/link?startupMs=0&kbps=0&stalled=false'
```

Record each event’s epoch milliseconds and monotonic timestamp with candidate identity and the screen recording clock. Request/response/closed events share an id and contain only logical fixture identity, normalized numeric byte range, HTTP status and emitted byte count, never URLs, credentials or private headers. Response status distinguishes HTTP refusal from format refusal. Cleanup waits for handlers before writing final active/held counts. Measure play intent to first observed picture, first observed buffering after the stall, buffer duration and recovery after clearing it; record timeouts/refusals, never omit them. Run baseline `(0,0,false)`, delayed `(1500,0,false)`, constrained `(1500,256,false)`, then stall/recover. Repeat for TS Live, range title and no-range title. Report these as observations of the exact candidate/conditions, not a performance comparison measured on busy forge.

For the existing HLS server, `POST /live-link?kbps=256` paces new single-rendition live segments only; restore with `kbps=0`. `POST /fail-live?id=<id>&count=1` refuses a playlist. It does not control multitrack, title or archive bodies, nor resume an in-flight segment. Those network routes remain unmeasured unless Evidence adds an isolated transport boundary and records it. Native event/ladder HLS movies use the formats panel controls above; outcomes still need installed observation.

After each row stop playback and observe closed requests before moving on. `/state` reports active proxy responses, response bodies currently held by the stall, and condition events, not native hold settlement or decode counters. `session.json`, `provenance.json` and `network.json` are retained under the chosen ignored output directory. SIGINT/SIGTERM closes the panel, active HTTP connections and control port. Evidence must also remove its app/profile, fixture hosts, M3U file and owned forwarding rules:

```sh
$ANDROID_HOME/platform-tools/adb -s emulator-5554 reverse --remove tcp:8891
$ANDROID_HOME/platform-tools/adb -s emulator-5554 reverse --remove tcp:8791
```

Remove only reverses created for the check, including any ephemeral fixture ports. Close the AgentDevice session and call `device_close` with `shutdown: true`, following the android-emulator skill's cleanup procedure. Record cleanup failures explicitly.

## Remaining gaps and UI handoff

There is no installed outcome in this source change, and no demonstrated native decoder gap justifies adding a library. Media3 declares support per renderer; absent MPEG-4 Part 2 and VP8 entries were added to the phone decoder inventory only. No source admission, holds, headers, PiP or offline binding is changed.

The configured Opus designer should inspect the existing Paper A/p-7-0 failure and capability surfaces. The UI must keep per-track unsupported outcomes distinct from observed playback and offer existing retry/track actions without promising a codec works because it is listed. No UI was changed here. Ask for a new Paper frame if the accepted surface cannot express those states. DTS/DTS-HD, Vorbis, FLAC, PCM/WAV, Ogg, FLV, raw MP3/ADTS and formats without a named fixture remain unqualified; container declarations do not close them. Physical codec/audio routes and receivers require their own results. Any future native library requires source, licence, provenance, ABI and 16 KB qualification before inclusion.
