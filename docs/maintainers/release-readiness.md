# Release readiness

> For maintainers. This is a record of evidence, not legal clearance. A check marked verified means someone looked at the named artifact or document and saw what the row says. Nothing here establishes that a licence, Store policy, trademark or patent question is settled, and a Store approval wouldn't either.

Recorded on 2 October 2026 for slice 6. It covers the licences the installers carry, the source offer, the Store's licence terms, TMDB and JustWatch, branding, the adult tab, codec patents, the Belgian publisher and the brand.

Evidence came from:

- the 0.0.3 release's assets (`v0.0.3`, built from `d87f835`), downloaded read-only and unpacked: the AppImage, the deb, the Mac zip and the Windows setup
- a local `pnpm build` and `pnpm dist:linux` of `main`, with `apps/desktop/scripts/build-ffmpeg.sh linux-x64`
- the `release dry run` of [#54](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/54) ([run 36975853640](https://github.com/Mr-Streamer-OSS/MrStreamer/actions/runs/36975853640)), whose signed Mac app ran on the workbench Mac mini
- the public documents linked in each section, read on 2 October 2026

Statuses: **verified**, **gap** (a known problem, with its fix or owner) and **open** (a question only Wout, Microsoft or an advisor can settle). The gate is the first step a row blocks: the **private Store test** or the **public launch**.

## Summary

| #   | Item                                                   | Status                                    | Gate               | Owner              |
| --- | ------------------------------------------------------ | ----------------------------------------- | ------------------ | ------------------ |
| 1   | The app's own GPL-3.0 text in the installed app        | Gap in 0.0.3; fixed by #59                | Private Store test | Agent (licences)   |
| 2   | Third-party notices in each installed app              | Gaps in 0.0.3; fixed by #54, #59          | Private Store test | Agent (licences)   |
| 3   | Electron, Chromium and Node.js licences and source     | Verified; one open question               | Public launch      | Wout               |
| 4   | FFmpeg and x264 source, configuration and build script | Verified for GitHub releases              | Private Store test | Agent (licences)   |
| 5   | The source offer for Store packages                    | Open                                      | Private Store test | Agent (MSIX), Wout |
| 6   | How long sources stay available                        | Gap                                       | Private Store test | Wout               |
| 7   | Store licence terms and copy protection                | Open                                      | Private Store test | Wout               |
| 8   | Source link and privacy link in About                  | Verified in a #59 build                   | Private Store test | Agent (licences)   |
| 9   | TMDB and JustWatch attribution                         | Verified                                  | Private Store test | Agent (licences)   |
| 10  | TMDB API account and commercial use                    | Open                                      | Public launch      | Wout               |
| 11  | Branding, listing copy and demo assets                 | Verified for the repository; listing open | Private Store test | Agent (MSIX), Wout |
| 12  | The dedicated adult tab and Store content policy       | Open                                      | Private Store test | Wout               |
| 13  | Codec patents                                          | Open                                      | Public launch      | Wout               |
| 14  | Belgian publisher classification and disclosures       | Open                                      | Public launch      | Wout               |
| 15  | Benelux and EU brand clearance                         | Open                                      | Public launch      | Wout               |

## 1. The app's own GPL-3.0 text

Gap in 0.0.3, fixed by [#59](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/59). Gate: private Store test.

GPL-3.0 section 4 asks that every recipient gets a copy of the licence, and section 5 asks that a conveyed version with an interactive interface shows the copyright, the lack of warranty and how to read the licence. In 0.0.3 the only trace was `"license": "GPL-3.0-only"` in `app.asar`'s `package.json` and "GPL-3.0" in About:

- AppImage and deb: `LICENSE.electron.txt`, `LICENSES.chromium.html` and `resources/ffmpeg/LICENSE-{FFmpeg,x264}.txt`; no Mr. Streamer licence, no `/usr/share/doc/mrstreamer/copyright`.
- Mac zip and Windows setup: the same, minus the Chromium credits on Mac (see 2).

#59 adds Mr. Streamer to `apps/desktop/licences.config.json`: copyright, the no-warranty notice, where the source is, then the repository's `LICENSE`. A local Linux build lists it under Settings > About > Open-source licences as `Mr. Streamer 0.0.3, GPL-3.0-only`, 35,714 characters. Still to check once #59 ships in a nightly: the same entry on Mac and Windows installs.

## 2. Third-party notices in each installed app

Gaps in 0.0.3, fixed by [#54](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/54) and [#59](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/59). Gate: private Store test.

Every 0.0.3 installer carries the same `out/licences/third-party.json`: 55 notices, from the packages the bundles hold plus Electron, Chromium, Node.js, FFmpeg and x264 ([development](development.md#third-party-notices) describes how it's built).

| Platform | What 0.0.3 ships                                                                                                                    | Gap                                                                                                                                                                                 | Fix |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Linux    | `LICENSES.chromium.html` and `LICENSE.electron.txt` beside the executable; ffmpeg's licences and `README.txt` in `resources/ffmpeg` | None found                                                                                                                                                                          |     |
| macOS    | ffmpeg's licences in `Contents/Resources/ffmpeg`                                                                                    | No `LICENSES.chromium.html` anywhere in the app, so About > Chromium and Node.js fail with "Chromium's credits page (LICENSES.chromium.html) is missing", checked on the Mac mini   | #54 |
| Windows  | Credits and Electron's licence beside the executable; ffmpeg's licences in `resources/ffmpeg`                                       | `ffmpeg.exe` statically links the MinGW-w64 runtime and winpthreads (its strings name `winpthreads/src/clock.c` and "Built by MSYS2 project 16.2.0"), whose notices weren't shipped | #59 |
| Windows  | `resources/elevate.exe`, electron-builder's elevation helper, © 2007 Johannes Passing                                               | No licence text in the binary or in electron-builder's NSIS bundle, and per-user installs never use it                                                                              | #54 |

After #54, the dry run's signed Mac app has `Contents/Resources/LICENSES.chromium.html`, and on the Mac mini it returns Chromium's credits (19,612,804 characters) and Node.js's licence through the same call About makes. Its Windows setup has no `elevate.exe`. After #59, About lists `MinGW-w64 runtime` with the runtime's licence file and winpthreads' `COPYING`.

Still open, Windows direct download only:

- The NSIS installer stub carries NSIS (zlib licence) and its plugins, among them `nsis7z.dll`, which is built from 7-Zip. They run during installation and aren't installed, and their notices aren't in About. The MSIX doesn't use NSIS. Owner: Wout; gate: public launch.
- `dxil.dll` and `d3dcompiler_47.dll` come with Electron from Microsoft's SDKs. Chromium's credits list `DirectX-Shader-Compiler` but not those two binaries by name.

## 3. Electron, Chromium and Node.js

Verified, with one open question. Gate: public launch.

- Electron is MIT; its `LICENSE` is in About and beside the executable on Linux and Windows.
- Chromium's credits page (779 projects on Linux) holds Node.js's licence, FFmpeg's for the LGPL build behind Electron's `libffmpeg`, libvpx, dav1d, opus, OpenH264, SwiftShader, Vulkan and DirectX Shader Compiler among others. About links Chromium's source at the exact tag (`152.0.7977.130` in 0.0.3) and Node.js's at its tag (`v24.21.0`).

Open: LGPL parts inside Chromium, `libffmpeg` above all, rely on Chromium's public source at that tag. The releases don't attach copies, as they do for FFmpeg and x264. Whether the upstream tag is enough of a source offer is Wout's call.

## 4. FFmpeg and x264

Verified for GitHub releases. Gate: private Store test.

- Every one of the 23 published releases, nightlies included, attaches `ffmpeg-9.0.2.tar.xz` and `x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz`. The 0.0.3 FFmpeg archive matches the SHA-256 pinned in `build-ffmpeg.sh` (`8c3850…e002e`); the x264 archive is that commit, 289 files.
- `resources/ffmpeg/README.txt` in each installer names both versions and the full configure line. FFmpeg's notice in About links the sources attached to `v{version}` and `build-ffmpeg.sh` at that tag.
- The configuration enables only playback's codecs (see 13), with `--enable-gpl --enable-libx264`, so the program is GPL-2.0-or-later.
- The release workflow caches the ffmpeg build by the hash of `build-ffmpeg.sh`, so each binary matches the script at its commit.

Open: the toolchains aren't recorded. Mac builds use the runner's Xcode, Linux builds Ubuntu 22.04's GCC in Docker, and Windows builds MSYS2's packages of the day: in 0.0.3, GCC 16.2.0, as the binary says, and whichever MinGW-w64 runtime MSYS2 shipped then. Compilers fall outside the source the GPL asks for, but the MinGW-w64 runtime and winpthreads are linked into `ffmpeg.exe`. Pinning or recording those versions in `README.txt` belongs to whoever next changes `build-ffmpeg.sh`.

## 5. The source offer for Store packages

Open. Gate: private Store test. Owners: the MSIX packaging work for the package, Wout for the choice below.

A Store package carries the same notices as the direct download, so it inherits the release's source links. They hold only if:

- the submitted MSIX comes from a release run whose GitHub release publishes with the same version, so FFmpeg's notice links `releases/download/v{version}/` assets that exist. [#57](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/57), open, maps stable 0.0.4 to package version `1.0.4.0`, and makes dry runs and nightlies sideload-only test packages the Store refuses. Its `.msix.txt` names the release version, package version and commit.
- About's Source row names the commit (`__BUILD_COMMIT__`, from #59).
- the MSIX keeps `resources/ffmpeg/` with its licences and `README.txt`, `LICENSES.chromium.html` and `LICENSE.electron.txt`. #57 reports all of them in its package; check again in the package actually submitted.

The licence question: FFmpeg and x264 are GPL-2.0-or-later. Version 2, section 3, counts source as offered alongside a binary only when it comes "from the same place"; the Store isn't GitHub. Otherwise it asks for the source to accompany the binary, or for a written offer valid for three years. Version 3, section 6(d), allows the source on "a different server (operated by you or a third party)... provided you maintain clear directions next to the object code saying where to find the Corresponding Source". Options for Wout:

- Convey FFmpeg and x264 under version 3 and put clear directions next to the Store copy: the Store description, About and the notices.
- Also add a three-year written offer to FFmpeg's notice, with a contact address.
- Attach the sources somewhere the Store listing links directly.

## 6. How long sources stay available

Gap. Gate: private Store test. Owner: Wout.

The [releasing runbook](releasing.md#recovery) says a bad release can be deleted. Deleting a release deletes the only copy of its FFmpeg and x264 sources, while installs of it remain. GPL-2.0 asks for a three-year offer; GPL-3.0 section 6(d) keeps the source due "for as long as needed to satisfy these requirements". Deciding how long to keep releases, or at least their source archives, is Wout's call; the runbook should then say so.

## 7. Store licence terms and copy protection

Open. Gate: private Store test. Owner: Wout, in Partner Center.

- Microsoft's [App Developer Agreement](https://go.microsoft.com/fwlink/?linkid=528905) (version 8.11, effective 17 April 2026): if the publisher provides no licence terms in the product description materials, the Standard Application License Terms (SALT) apply between the publisher and customers. Its FOSS clause leaves compliance with the licence, "including any source code availability requirements", to the publisher.
- SALT, in the agreement's Exhibit G, says customers may not work around technical limitations, reverse engineer the app or make more copies than it allows. GPL-3.0 section 10 forbids "further restrictions" on the rights it grants.
- GPL-3.0's Installation Information rule applies to object code conveyed with a "User Product", a consumer device changing hands. A Store download onto the user's own PC isn't that. This is a reading of the licence, not advice.

What to choose, recorded for Wout to decide:

- **Licence terms.** Give GPL-3.0 as the app's licence terms in the submission, as a link to `LICENSE` or its text, so SALT doesn't apply. Check the field's current name in the dashboard; the listing and support pages read on 2 October don't mention it.
- **Pricing.** Free.
- **Organizational licensing.** Store-managed online licensing is on by default; offline licensing lets organisations redistribute the package. Neither limits what the GPL grants.
- **Copy protection.** Choose nothing that encrypts or locks the package. The Store's signature on the MSIX doesn't limit what the GPL grants.

## 8. Source and privacy links in About

Verified in a build of #59. Gate: private Store test.

- Source: in a build of #59, About reads "GitHub · c80da1b · GPL-3.0", the short commit linking to `https://github.com/Mr-Streamer-OSS/MrStreamer/tree/<commit>`. `electron.vite.config.ts` builds in the checkout's HEAD. The JS bundle of #59's dry run, built by the release workflow's depth-1 checkout, holds the PR's head commit, `fc1b591`. A folder outside a git checkout of the repository gives no commit, and About then links only the repository.
- Privacy: About links `https://mrstreamer.app/privacy`. Since 2 October that address answers 302 with `docs/privacy.md` on `main` on GitHub, which [#60](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/60) added the same day; `curl -I` on that target answers 200. A marketing landing page at that address is a later slice. The same URL goes into Partner Center (Store policy 10.5.1).

## 9. TMDB and JustWatch attribution

Verified. Gate: private Store test.

- [TMDB's API terms](https://www.themoviedb.org/api-terms-of-use), last updated 20 October 2023, section 3: use TMDB's logo, less prominent than the app's own marks, and show "This [application] uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB" prominently.
- Settings > About shows TMDB's logo, small and below the app's own rows, with that sentence.
- Section 1.C forbids caching anything for longer than six months; `apps/desktop/src/main/ondemand/metadata.ts` stops using and keeping metadata after six months.
- TMDB's watch-provider data must be credited to JustWatch. About says "Where titles stream comes from JustWatch" with a link, and the Services tab says "Where titles stream, from JustWatch."

## 10. TMDB API account and commercial use

Open. Gate: public launch. Owner: Wout.

- The release builds carry the read token from the repository secret `TMDB_API_KEY` ([releasing](releasing.md#tmdb-key)), issued to Wout's TMDB account. Nobody has checked that account's application details: that they name Mr. Streamer (section 1.C forbids hiding the application's identity) and that the use is registered as non-commercial.
- Section 2 allows non-commercial use only. Charging, ads, selling access or "deriving revenues... directly or indirectly" needs a written agreement with TMDB. Mr. Streamer is free and shows no ads, so today's use reads as non-commercial. Any monetisation, donations included, needs a new review of TMDB's terms first.
- Section 1.C(e) forbids using the API with an application that, in TMDB's sole discretion, is used primarily for pornographic content. Mr. Streamer isn't, and it asks TMDB about titles marked for adults only while the viewer has them turned on (`apps/desktop/src/main/ondemand/catalogue-worker.ts`, `wantedOf`). This belongs with 12.

## 11. Branding, listing copy and demo assets

Verified for the repository; the Store listing is open. Gate: private Store test.

- The README says "A desktop player for the IPTV subscription you already have" and needs the user's own Xtream Codes provider. Nothing in the repository supplies channels, playlists or provider promotions.
- The README banner and screenshots come from the fake provider with made-up titles, artwork and people, as the [development runbook](development.md#artwork) requires.
- The listing, its screenshots and the demo provider for certification don't exist yet ([Microsoft Store setup](microsoft-store.md#4-prepare-a-private-submission)). They need the same rules: state at the start of the description that the app supplies no channels and needs the user's own subscription (Store policy 10.2.4 asks for dependencies to be disclosed at the beginning of the description), lawful screenshots only, and a demo provider with lawful content.
- IPTV players such as Smarters present themselves as standalone players for content users bring. That positioning is no exemption from Store policy or provider rights, and Smarters' terms are no template for a GPL licence.

## 12. The dedicated adult tab

Open until the Live TV filter lands. Gate: private Store test. Owner: Wout; Microsoft support has answered.

What the app does, from the code on `main`:

- Titles count as for adults when the provider sets `is_adult` on a movie or series (`apps/desktop/src/main/providers/xtream.ts`), or when the category's name holds one of a short list of whole words (`packages/core/src/adult.ts`, `isAdultCategory`): XXX, porn, porno, 18+, +18, and adult in English, French, Spanish and Portuguese, Italian, German and Dutch, with their plurals. "Adult Swim", a cartoon channel, isn't one, and rating words such as "mature" aren't on the list.
- So the gating depends on the provider's flags and category names. Slice 6's current-state review found categories the earlier rule missed, "+18", "ADULTOS +18", "FR| ADULTES", "PORNO", "DE| ERWACHSENE" and "NL| VOLWASSENEN"; the list now reads them, and `packages/core/test/catalogue.test.ts` holds the names it must and mustn't match. A provider answering `[]` for its categories keeps the categories from before, so it no longer unmarks them. A category named in another language, or a first fetch without categories, still depends on the provider's flags.
- They're hidden by default. Settings > General > "Titles for adults · in their own tab, never on Home or in search" turns on an Adults tab in Movies and Series with the provider's names and posters (`adultTitles`, off when absent). They never appear on Home, in search or in Continue watching. There is no PIN or age check.
- Live TV has no such filter. `is_adult` is read for movies and series only, so a provider's adult live categories, channel names, logos and guide show in Live TV, the guide and search like any other.
- Ordinary mature-rated films, horror or an 18-rated drama, appear like any other film unless the provider marks them or their category as adult.
- TMDB is asked about titles for adults only while the setting is on (see 10).

Store policy, in [version 7.19](https://learn.microsoft.com/en-us/windows/apps/publish/store-policy-archive/store-policy-7-19) (effective now) and [7.20](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) (from 22 October 2026, no change to these sections):

- 11.7: "Your product must not contain or display content that a reasonable person would consider pornographic or sexually explicit."
- The content policies define content to include "anything that's delivered from a server or that the product connects to".
- 11.11.3: content "that might be appropriate for a higher age rating than its assigned rating" needs users to opt in "by using a content filter or by signing in with a pre-existing account".

The question for Microsoft, as precisely as it can be put: Mr. Streamer hosts and supplies no content; it plays the user's own subscription. Some providers mark titles and categories as adult. The app hides them unless the user turns on an opt-in setting, which shows the provider's names and posters in a separate tab, and never on Home or in search. Live TV lists all of the provider's channels, including any adult ones. Does an opt-in filter for content from the user's own provider meet 11.7 and 11.11.3, or must a Store package be unable to show it at all?

Microsoft support confirmed on 2 October 2026 (reported by Wout; reply kept in his Partner Center support case) that the opt-in filter meets 11.7 and 11.11.3, with Live TV following the same setting.

Decided by Wout on 2 October 2026: Live TV follows the "Titles for adults" setting in every build, with the same category rule, so adult channels hide by default too. Every distribution keeps the Adults tab. This item is resolved once the Live TV filter lands; until then Live TV shows adult channels as described above.

## 13. Codec patents

Open. Gate: public launch. Owner: Wout, with an advisor if he wants one. This section lists facts about the build; it doesn't conclude that any fee is or isn't due. GPL licences and Store signing don't grant patent licences.

What the 0.0.3 build decodes and encodes:

| Component                          | Decodes                                                                                                                                                                                                                                      | Encodes                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Bundled ffmpeg (`build-ffmpeg.sh`) | H.264, HEVC, MPEG-1 and MPEG-2 video, MPEG-4 Part 2, MS-MPEG4 v3, H.263, FLV; MP2, MP3, AAC, AC-3, E-AC-3, DTS, TrueHD, MLP, FLAC, Vorbis, Opus, PCM                                                                                         | H.264 (x264), AAC, WebVTT, DVB subtitles       |
| Chromium's media stack in Electron | H.264, AAC and MP3 through Electron's `libffmpeg`, built with `proprietary_codecs = true` ([Electron's `build/args/all.gn`](https://github.com/electron/electron/blob/v44.4.5/build/args/all.gn)); VP8, VP9 and AV1 through libvpx and dav1d | Not used by the app; the credits list OpenH264 |
| The operating system               | HEVC through VideoToolbox on macOS, and hardware decoders on Windows and Linux where present                                                                                                                                                 |                                                |

Playback depends on these. Every converted stream ends as H.264 and AAC for Chromium to decode, so dropping Electron's proprietary codecs, for example by swapping in the `ffmpeg` build Electron publishes without them, would stop playback of most channels.

Distribution and markets: free, as source and binaries from GitHub Releases to anyone, from Belgium; the private Store test reaches Wout and a few testers. Public Store markets aren't chosen yet. Codec patents are granted in Europe too, and terms differ by country.

Who licenses these formats, to consult before the public launch:

- H.264: Via LA's AVC/H.264 pool. Its published terms count encoder and decoder units per legal entity per year, with the first 100,000 royalty-free.
- HEVC: Access Advance and Via LA.
- AAC, MPEG-2 video and MPEG-4 Part 2: Via LA.
- AC-3, E-AC-3 and TrueHD: Dolby. DTS: Xperi.
- [FFmpeg's legal page](https://ffmpeg.org/legal.html) says the FFmpeg project can't answer patent questions and that the answer depends on where you live.

## 14. Belgian publisher classification and disclosures

Open. Gate: public launch. Owner: Wout.

- Wout describes Mr. Streamer as a free, non-commercial hobby project and opened an Individual Partner Center account in Belgium ([Microsoft Store setup](microsoft-store.md)). A free hobby release doesn't by itself require incorporating or registering for VAT.
- Store policy 10.14 requires a Company account "for organizations, businesses, and any person acting in relation to their trade or profession", or when "a reasonable consumer would interpret your application or publisher name to be that of a business entity". The reserved publisher display name is `Mr Streamer OSS`. Whether a consumer could read that as an organisation is worth Wout's look before the first submission, since Microsoft doesn't convert Individual accounts to Company ones.
- The EU Digital Services Act asks marketplaces to verify traders, any person "acting in relation to his or her trade, company, business, or profession" ([Microsoft's page](https://learn.microsoft.com/en-us/windows/apps/publish/store-business-verification-reqs)). A Company account must give customer support contact details, which Microsoft shows on the product page in some regions.
- The FPS Economy's [guidelines on e-commerce information](https://economie.fgov.be/sites/default/files/Files/Entreprises/guidelines-obligations-information-dans-le-cadre-du-e-commerce.pdf) (28 September 2026) apply to enterprises concluding distance contracts where the consumer pays or promises a price: name, address, email, phone and enterprise number. Mr. Streamer charges nothing. Whether Book XII's information duties for information society services reach a free app is open.
- Today the deb names "Wout Stiens <hello@mrstreamer.app>" as maintainer, the installers carry "Copyright © 2026 Wout Stiens", and the [privacy policy](../privacy.md) names the data controller as "Wout Stiens, Belgium, publishing as Mr Streamer OSS", with privacy@mrstreamer.app. It also says "Mr Streamer OSS is based in Belgium" and speaks as "we", which bears on the 10.14 question above.

Any monetisation, a business setup or an organisation as publisher reopens this row: enterprise registration, VAT, a Company account and the disclosures above.

## 15. Benelux and EU brand clearance

Open. Gate: public launch. Owner: Wout.

Name availability in Partner Center isn't trademark clearance. A search in [TMview](https://www.tmdn.org/tmview/), which holds the BOIP (Benelux) and EUIPO registers, on 2 October 2026 found:

- "mrstreamer" in every TMview office: one similar result, "erstreamer" (Türkiye, registered, classes 9, 10, 12, 35, 38, 41, 42, 45). No "Mr. Streamer" or "Mr Streamer" mark.
- "mr streamer" in BOIP and EUIPO, classes 9, 38, 41 and 42: 3,440 similar marks. None of the 30 most similar contains "Mr"; they are word marks on "Streamer" alone or with another word: STREAMER, EUIPO 018750397, registered for classes 41 and 42 (Croconi Management FZCO); STREAMER, EUIPO 018638681, class 9; GStreamer, EUIPO 011784253, classes 9, 41 and 42; Streemer, EUIPO 018871445 and 018848825, classes 35, 38, 39, 41 and 43; THE STREAMERS, BOIP 1438938, classes 25, 41 and 43.

That's what a search shows, not an opinion on conflict. Before the public launch, Wout decides whether to have a professional clearance search done, and whether to file "Mr. Streamer" himself.
