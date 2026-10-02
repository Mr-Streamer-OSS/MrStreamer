# Slice 6: everyday viewing and release readiness

Status: implemented. Parts 1 to 9 and the scope added along the way merged on 2 October 2026 as #48 to #96. [Stable 0.0.5](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.5), published the same day from `9040bb1`, carries #48 to #93; Stable 0.0.4 came before it. Wout [accepted](#acceptance) it on the Mac, Windows and Linux on 2 October 2026. The Store's first private submission, package `1.0.4.0`, passed certification, was published privately and installed on his PC from the testers' link the same day. What remains is the Store update test with submission 2, `1.0.5.0`, two Store checks that go with it, and the [known gaps](#known-gaps). The [measurements](#measurements) found no regression.

Outcome: comfortable daily viewing on the Mac and Windows, verified Linux packages, and a documented, tested path to a Windows Store build distributed privately. Mr. Streamer stays a free, open-source player for the user's own subscription. The public Store launch waits for the base release's acceptance.

## Start here

- What users see: [Live TV](../../user/live-tv.md), [Movies and series](../../user/movies-and-series.md), [What plays](../../user/playback.md), [Updates](../../user/updates.md) and the [privacy policy](../../privacy.md).
- Readiness: the [release readiness record](../release-readiness.md) for licences, content and the launch gates, and the [privacy audit](../privacy-audit.md) behind the policy.
- How it works: [architecture](../../contributing/architecture.md), [testing](../../contributing/testing.md), [releasing](../releasing.md), [signing](../signing.md), and slice 5's [known gaps](05-tracks-languages-and-details.md#known-gaps), carried below.
- Store: [Microsoft Store setup](../microsoft-store.md) owns the dashboard steps, the package identity and the private submission checklist. This handoff owns product scope and acceptance.
- Baseline: `main` at `87d740e`. Stable 0.0.3, published on 2 October 2026, was built from `d87f835`. Implementation starts from the latest `main`, and each pull request records the commit it started from.
- The second review covered `6a128ac`. Its fixes, #37 to #44, and the later #46 and #47 merged after it. A merged fix isn't independent verification, so recheck their behaviour on the implementation baseline.

## Decisions

Wout settled these when approving the handoff:

| Question       | Answer                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP providers | Keep HTTP compatibility, disclose the risk and leave the choice of provider with the user. No silent downgrade; redact credentials      |
| Adult tab      | Clarify Microsoft's policy first. Leave the tab out of the Store package only if needed and Wout agrees                                 |
| Store          | Private testing in this slice: an MSIX beside the direct EXE, installed through the Store by a known group of testers                   |
| Deferred       | The public Store listing, Store submission automation and the marketing landing page, in slice 8                                        |
| Quality        | Full HD is the default preference. Only Auto falls back by itself, and only to a confirmed equivalent variant                           |
| Next episode   | On by default, with a toggle in General and a ten-second countdown that can be cancelled                                                |
| Updates        | Store installations update through the Store; direct installations keep the current flow                                                |
| Signing        | Microsoft signs the MSIX the Store delivers. Paid signing of the direct EXE stays deferred and doesn't hold up the slice                |
| Legal          | Privacy pages and licence and source checks are readiness work here. National, content, trademark and codec questions stay launch gates |

The screens were picked on 2 October from options compared side by side outside the repository:

| Area               | Pick                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next episode       | 1A: a ten-second countdown on the Next Up screen, with Play now and Cancel                                                                                                       |
| Live quality       | 2A: a quality button beside Sound and CC that says what plays; Q opens it                                                                                                        |
| Episode details    | 3C: every row carries the still, name, rating, date, length, story and credits, with nothing to click                                                                            |
| Controls           | 4B: one sliders menu beside CC, with pages for speed, subtitle timing and subtitle look                                                                                          |
| Picture in picture | 4F: a mini player, the app's own window shrunk and kept on top. Chromium's picture in picture shows no subtitles, and Document Picture-in-Picture opens no window in Electron 44 |
| Unencrypted logins | 5A: an address without a scheme tries https first, and one confirm step comes before http                                                                                        |
| Store updates      | 6A: one row, "updated by the Microsoft Store", with Open Store                                                                                                                   |
| Playlists          | B: Movies and Series are hidden for a playlist without a login                                                                                                                   |

Wout settled these during the slice, all on 2 October 2026:

| Question             | Answer                                                                                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Episode details      | A rating shows once five people voted. Credits are directors and guest stars, without writers                                                                                                                                                                                                                                     |
| Next episode         | Specials (season 0) lead only to other specials, so a finale never offers one. The countdown holds while Settings is open and carries on when it closes. Entering the mini player doesn't stop it                                                                                                                                 |
| Playlists            | Login-free M3U playlists, such as iptv-org's, come forward into this slice for live TV only                                                                                                                                                                                                                                       |
| Testing              | Real-app checks of live TV use iptv-org's playlist. The fakes stay for CI, the packaged-app test, the measurements and on-demand checks, which no public source offers                                                                                                                                                            |
| Redirects            | An https address never follows a redirect to http that carries the login. A redirect to http without it, such as a stream token, is still followed                                                                                                                                                                                |
| Remove subscription  | It offers "Also delete favourites, history and progress", unticked by default                                                                                                                                                                                                                                                     |
| Adult channels       | Live TV follows the "For adults" setting in every build                                                                                                                                                                                                                                                                           |
| Own TMDB key         | Stays in plain text, disclosed in the privacy policy, and tracked as a gap                                                                                                                                                                                                                                                        |
| Privacy              | Contact privacy@mrstreamer.app, delivery verified on 2 October. The policy is at `https://mrstreamer.app/privacy`, for now a redirect to [`docs/privacy.md`](../../privacy.md). One formal line names Wout as the data controller                                                                                                 |
| Store versions       | Only stable releases go to the Store, numbered `(major+1).minor.patch.0`. The added 1 stays for good                                                                                                                                                                                                                              |
| Publisher name       | "Mr Streamer OSS" has no period because Partner Center doesn't allow one                                                                                                                                                                                                                                                          |
| Nightly channel      | Nightly offers nightlies only, never a stable release and never an older build. Every nightly already carries the stable release's commits                                                                                                                                                                                        |
| Stable runs          | A stable run needs the tested nightly. When `main` has commits no nightly carries, the run first publishes a nightly of `main` (option A)                                                                                                                                                                                         |
| Source offer         | Links to the exact release's sources, from About's Source row and the Store listing. No separate written offer                                                                                                                                                                                                                    |
| Releases             | Never deleted, so their GPL sources stay. Recovery takes a bad release's update files away instead                                                                                                                                                                                                                                |
| Store licence terms  | GPL-3.0, entered under Partner Center's "Additional license terms". The app stays free                                                                                                                                                                                                                                            |
| TMDB                 | The API account is registered as non-commercial, confirmed by Wout                                                                                                                                                                                                                                                                |
| Brand                | "Mr. Streamer" is approved for launch without a professional clearance search                                                                                                                                                                                                                                                     |
| Codec patents        | The approach of VLC, Kodi and mpv: distribute without signing up to patent pools, and accept the risk. No advisor. Revisit on any monetisation, or if a pool makes contact                                                                                                                                                        |
| Microsoft's guidance | Microsoft support approved, as Wout reports: http logins with the 5A flow (policy 10.5.4), the opt-in adult filter with Live TV following it (11.7 and 11.11.3), and the Individual account as "Mr Streamer OSS" (10.14). No https-only or adult-free Store package is needed. The reply is in Wout's Partner Center support case |
| Store submission 1   | Private audience, free, and held until Wout selects Publish now. IARC answers describe what the app can show, which rates it 18+. The [runbook](../microsoft-store.md#submission-1) records what was entered and why                                                                                                              |
| Stable 0.0.4         | Promoted from the approved nightly `0.0.4-nightly.20261002.110`. Later fixes, #89 to #92 among them, went into 0.0.5, which also tests a Store update                                                                                                                                                                             |

Working agreements:

- Each part gets a focused pull request with its own validation and documentation, split further when it would mix unrelated changes. Rebase on the current `main`, audit the final revision before filing and resolve verified review findings.
- The implementation agent may merge completed pull requests once required checks and review pass; follow-up fixes can land separately. That doesn't authorize a stable release or making the Store listing public.
- Substantive UI starts as several distinct options compared outside the repository. Components change after Wout picks one. The design stays as agreed: black background, white primary text, minimal copy, a large backdrop where useful, consistent navigation and no decorative chrome.
- Settled requirements are recorded here, never as links to outside planning pages.

## Parts

| Part | Deliverable                                                | Depends on                                     |
| ---- | ---------------------------------------------------------- | ---------------------------------------------- |
| 1    | Current-state review and the Continue watching removal fix | The latest `main`                              |
| 2    | Automatic next episode                                     | Viewing state and episode order                |
| 3    | Logical live channels and quality variants                 | A review of provider identity                  |
| 4    | Richer episode details                                     | The existing lazy metadata path                |
| 5    | Everyday controls and consistent navigation                | Wout's UI pick and what each platform supports |
| 6    | Privacy policy and credential protection                   | A network and data audit; HTTP kept, disclosed |
| 7    | Packaged licences, source and launch obligations           | The exact distributed artifacts                |
| 8    | Windows MSIX packaging and Store-aware updates             | Microsoft identity; parts 6 and 7              |
| 9    | Microsoft setup guide and private submission preparation   | A Store-ready package and Wout's account steps |
| 10   | Cross-platform acceptance and final documentation          | Every implemented part                         |

Parts 6 and 7 can start beside the viewing work. Packaging can be built before account verification finishes, but Store readiness needs the real identity and certification evidence.

### 1. Review the current state and fix Continue watching

Review public behaviour across playback, catalogue and details, settings, persistence, and the release and update paths. Reproduce each finding against the latest code before fixing it. Give every open gap from slice 5 a disposition: fixed, verified as existing behaviour, or tracked with evidence. No architectural rewrite without a demonstrated need.

Wout reports that Remove from Continue watching does nothing. Trace the UI action through IPC, the viewing service and the refreshed Home state; a passing service test alone doesn't close it. Removing a film or series removes its visible entry across quality versions, survives a restart, and keeps the viewing progress for a later deliberate resume. Playing the title again may make it eligible for Continue watching again. A failed removal shows, instead of being swallowed. Progress updates from a session still playing must not undo the removal.

Acceptance: removal shown in the installed app, still removed after a restart, and progress kept on a deliberate resume. Replacing the account doesn't show or reopen the old account's titles.

### 2. Automatic next episode

On by default, with a global toggle in General. At the actual end of an episode a ten-second countdown starts, and the viewer can cancel it.

- Follow the provider's episode order across season boundaries. Never infer the next episode from a stream id or a sorted display title.
- Keep the chosen series version and the language preferences where available. Never switch silently to a different series or an unrelated cut.
- End the current session, then start one next stream. No duplicate provider connections and no speculative playback.
- Cancelling, leaving Watch, switching accounts or starting another title drops pending work. A next episode that fails offers a useful way to recover. The final episode stops cleanly and records that the available series is finished.

Acceptance: on and off, cancelling, a season change, the final episode, an unavailable next episode and account-change races all behave. Pause, resume, track choice and the manual Next keep working.

### 3. Live quality variants

Show provider streams that are confidently the same channel as one logical channel with a choice of quality. Guide rows, favourites, history and the last-watched channel use that identity. Merge only when channel identity, region and language agree; a shared EPG id or a quality suffix alone isn't enough. Ambiguous entries stay separate.

Full HD is the default preference. Offer a global quality preference and remembered overrides per channel. Auto starts with the best match for the preference and may try a bounded set of equivalent variants when playback fails. A quality picked by hand stays picked: report the failure and offer another choice instead of overriding it. Show what is actually playing. Set the fallback limits from current playback behaviour and verify them; no retry loops and no concurrent provider connections.

Acceptance: one favourite and guide entry for confirmed variants, overrides that persist, the quality actually playing, a bounded Auto fallback, honest labels when the provider's quality is unknown, and no merging across regions or languages. Existing favourites and history migrate without loss, and the newest stable release can still read the newer data.

### 4. Episode details

Show the episode's own title, synopsis, still, air date, runtime, rating and credits when available. Ask TMDB about a season or episode only when it opens. Keep the existing lazy title details and cache bounds; never enrich a whole library, or every episode on hover.

The provider decides which episodes exist and play. TMDB adds to them, with the provider's metadata as fallback. A missing match or unavailable metadata never blocks playback or creates a phantom episode. Use the chosen content language and the fallback to the original name consistently.

Acceptance: sparse provider metadata, no TMDB key, slow or failed requests, translated titles, different series versions and account changes all behave. Request counts prove that unopened seasons and episodes aren't fetched ahead.

### 5. Everyday controls and navigation

Picture-in-picture, system media controls, playback speed on demand, subtitle timing and appearance, and consistent mouse, trackpad and keyboard behaviour across Watch, menus and details. Review play and pause, seeking, volume and mute, full screen, Back, Sound, CC and quality as one viewing flow. Ordinary scrolling moves content; changing playback or channels takes an intentional action. Closing a menu doesn't leave Watch or change channels by accident.

Check PiP and media-session support on the supported Electron, macOS and Windows versions first. Subtitles drawn over the main window don't prove that text or picture subtitles appear in PiP. Choose a supported approach, verify it and document platform limits instead of showing controls that do nothing. Keep one playback session, and keep its state when entering or leaving PiP or full screen. Speed keeps the pitch where supported and never applies to live playback.

Subtitle adjustments respect the chosen track and Off, apply again after seeking or changing tracks, and work for the supported text and picture formats. The CEA-708 gap carries into the review: claim the format only after playing a lawful, representative fixture.

Acceptance: Wout picked the UI, the installed Mac and Windows apps are verified, menus work by keyboard and pointer, focus lands sensibly after closing, and transitions keep pause, position, chosen tracks and volume.

### 6. Privacy and credential protection

Audit credentials, preferences, history, favourites, caches and diagnostics, and the network requests to the provider, artwork hosts, TMDB and the distribution services. Separate what stays on the device from what leaves it. Identify the processing the Belgian publisher actually controls, support and the hosting of the public legal page included.

Write a policy grounded in that audit: publisher and contact, purposes, recipients, retention, deletion, the user's rights and lawful bases where relevant. Keep its source in the repository and prepare a stable public HTTPS page, linked from About, the docs and the Store listing. This small legal page is readiness work; the marketing landing page comes later. Verify the deletion claims and credential redaction. Don't promise zero telemetry, or deletion on uninstall, without checking.

The provider adapter defaults an address without a scheme to HTTP and sends credentials as URL parameters. Wout keeps HTTP so users can choose their provider. Make the risk of an unencrypted connection clear, never downgrade silently and redact URLs that carry credentials. Propose HTTPS-first onboarding that doesn't make HTTPS a requirement or break an HTTP address entered on purpose. A warning or an acknowledgment doesn't encrypt credentials or make the app Store-compliant. Ask Microsoft about this behaviour before submitting, and don't restrict the Store build to HTTPS without Wout's agreement. The audit covers redirected requests and third-party artwork.

Acceptance: the disclosures match the shipped build, no credentials reach diagnostics or published evidence, every policy link works, and the transport decisions are written down before submission. Publishing the page needs the agreed publisher identity and contact, and an authorized host.

### 7. Licences, content and Belgian launch obligations

This part produces a readiness record backed by evidence, not a claim of legal clearance.

- The installed app carries its own GPL-3.0 text and every required third-party notice. Check Electron, Chromium and Node, and the actual FFmpeg and x264 build with its exact corresponding source, configuration and build instructions. The source attached to releases today is a baseline, not proof that a new MSIX complies.
- Source links work for Store package versions as well as GitHub releases, each tied to the exact commit shipped. Check any Store licence or copy-protection choice against the recipients' GPL rights.
- Keep the TMDB and JustWatch attribution, verify it against the current API terms and confirm the API account's actual permissions. Commercial use needs a new review before any monetization.
- Branding, listing copy and demo assets stay lawful and accurate: the user brings the subscription, the app supplies no channels, and there are no unauthorized playlists, provider promotions or circumvention. Smarters' terms for its standalone player show one way to position a player; they are neither an exemption nor a template for a GPL licence.
- Settle the dedicated adult tab's policy question with evidence. Ordinary mature-rated films aren't automatically pornography. Don't remove the feature silently from every distribution or hide it from reviewers.
- Record a focused codec-patent assessment for the actual build and launch markets. Neither the GPL nor Store signing clears patents, and the assessment doesn't by itself establish that a fee is due.
- Track the Belgian publisher classification and the identity and contact disclosures required when operating as a business, and Benelux and EU brand clearance. A free hobby release doesn't by itself require incorporating or registering for VAT.

Acceptance: licence evidence and truthful privacy and content disclosures go with the private Store test. Each remaining national, trademark and codec question has an owner and an explicit public-launch gate; none is presented as a passed check.

### 8 and 9. Windows distribution and Microsoft setup

Add Store-compatible MSIX packaging for Windows x64 beside the direct-download EXE, and keep the Mac signing and the Linux outputs. Store signing covers packages the Store delivers. It doesn't make the direct EXE, or a sideloaded MSIX, trusted.

Store installations update through the Store. General's update controls recognize that distribution and open the matching Store action instead of downloading an EXE, switching GitHub channels or replacing the package with electron-updater. Direct installations keep the automatic checks and the download and restart the user starts. Document which data each distribution owns when both are installed, and never share or overwrite an active profile unsafely.

The [runbook](../microsoft-store.md) has the exact checklist. Wout opened the publisher account and reserved Mr. Streamer on 2 October 2026, and the runbook records the [package identity](../microsoft-store.md#package-identity). For the rest of his steps, the notification email, the testers' group and the private submission, `scripts/setup-microsoft-store.sh` is a resumable wizard. He submitted the first private package the same day; the runbook records [submission 1](../microsoft-store.md#submission-1). Build and configure everything an agent can do first, and never ask for identity documents, passwords or secrets in chat. The slice prepares and assists the first manual private submission, and tests a real install and update from the Store once the account and certification steps are done. The existing nightly and stable policy and the cumulative stable notes don't change.

Acceptance: a valid package with the real Partner Center identity, the bundled playback resources and notices; Windows App Certification Kit results; a private-only submission; an install and an update on Wout's Windows PC that keep his data; and Store-aware settings. A package signed locally is no evidence of Store signing. While external verification or certification is pending, these parts stay pending without holding up unrelated feature work.

### 10. Verification and completion

Implementation pull requests run the repository's required checks. Tests cover public contracts and observable viewing behaviour, not restated implementation. Automation uses lawful fixtures; Wout's acceptance uses his subscription, with credentials only in the gitignored `.local/`.

| Platform       | Required evidence                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac            | The signed, notarized app installed; real live and on-demand playback and tracks; the new controls; an upgrade from the agreed baseline that keeps the data |
| Windows direct | The installed EXE; a real subscription, the viewing controls and an upgrade that keeps the data; the current update flow still works                        |
| Windows Store  | A real private MSIX from the Store; bundled playback works, Store updates keep the data, no EXE updater                                                     |
| Linux          | AppImage and deb install and launch, bundled playback, upgrade and package checks; GPU and PiP limits recorded separately                                   |

Recheck the second review's areas: resume after an account reset, CC Off, each channel's tracks, paused recovery, version choice from the quality tabs, late metadata, manual update checks and the live sound actually playing. Exercise Continue watching removal and next-episode transitions in the app, not only in services.

Compare startup, first picture, channel switching, guide and search responsiveness, connection counts and memory with the baseline, on the same machine and fixtures. Record regressions and fix the material ones; publish no timing claim without a measurement behind it. Update the user docs, the architecture where it changed, the runbooks, and this record with the actual pull requests and remaining gaps.

The slice is complete when the implemented parts have evidence, Wout's Mac and Windows acceptance is recorded and the required Store readiness gates pass. External waiting is tracked apart from code completion. Promoting a stable release and launching publicly in the Store stay explicit owner actions.

## Settled policy choices and gates

- **HTTP-only providers.** Keep HTTP compatibility, make the risk clear and leave the choice of provider with the user. Before submitting, check Microsoft's secure-transmission requirement against the actual credential flow. If certification demands a restriction, bring the finding and the distribution options to Wout; don't change the agreed behaviour quietly or claim that the user's responsibility waives the policy. Outcome: Microsoft support approved http logins with the 5A flow (policy 10.5.4), as Wout reports, so every build keeps them.
- **Dedicated adult tab.** Clarify Microsoft's policy first, and leave the tab out of the Store package only if needed and Wout agrees. Keep ordinary mature-rated films apart from prohibited explicit content. Neither this approach nor a generic-player disclaimer guarantees Store approval. Outcome: Microsoft support approved the opt-in filter (11.7 and 11.11.3) on condition that Live TV follows the same setting. #82 made it do so in every build, and every distribution keeps the Adults tab.
- **Setup inputs.** The publisher identity and contact, the testers' Microsoft account addresses and the host of the public legal page are inputs to setup, not reasons to stop independent work. Personal verification data and credentials stay out of this record.

## Deferred

- The rest of M3U and XMLTV import, in its own slice after the base release: movies and series from playlists, a separate XMLTV address and multiple subscriptions. Login-free live playlists came forward into this slice (#81).
- Multiple subscriptions, mobile and TV apps, downloads and trailers.
- The marketing landing page, the public Store listing and Store submission automation, in the launch and distribution slice after the base roadmap.
- Interface translation, apart from the existing content-language controls.

## Policy references

Checked on 2 October 2026. Check the policies in effect again before submitting.

- [Microsoft Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies), privacy, security, content, testability and ratings included. Version 7.19 is in effect; the published 7.20 takes effect on 22 October 2026.
- [TMDB FAQ](https://developer.themoviedb.org/docs/faq) and [JustWatch attribution](https://developer.themoviedb.org/reference/tv-series-watch-providers).
- [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) and [FFmpeg's legal guidance](https://ffmpeg.org/legal.html).
- The Belgian [Data Protection Authority's guidance](https://www.dataprotectionauthority.be/professionnel/premiere-aide/toolbox), [FPS Economy's publisher information](https://economie.fgov.be/nl/themas/online/elektronische-handel/verkoop-internet/bedrijfswebsite-en-accounts-op) and the [BOIP register](https://www.boip.int/en/trademarks-register).

## Review

Part 1 reviewed `ad7deac` and `ffa99bb` on 2 October, driving a Linux development build against the fake provider and fake TMDB.

The second review's fixes, rechecked on that baseline:

| Fix                       | Result                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| #37 resume after a reset  | Holds: with the series' details held back 5 s, replacing the account opened nothing                  |
| #38 CC Off                | Holds                                                                                                |
| #39 each channel's tracks | Holds                                                                                                |
| #40 paused recovery       | Holds for the retry that converts the sound. Two quick actions in a row were a new gap, finding 3    |
| #41 4K tab                | Holds when 4K isn't listed first; finding 7 when it is                                               |
| #42 late metadata         | Holds as tested; finding 5. Traced in the code but untested: details ignore TMDB's original language |
| #43 Check now             | Holds; finding 8                                                                                     |
| #44 live Sound menu       | Holds                                                                                                |
| #46 Back in the top bar   | Holds                                                                                                |
| #47 version names         | Holds for the documented cases; finding 13                                                           |

Each finding was reproduced before it was fixed:

| #   | Severity   | Finding                                                                                                                                    | Fixed by         |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 1   | Medium     | A channel picked in search over a playing movie opened Watch without sound                                                                 | #72              |
| 2   | Medium     | Categories for adults such as "+18", "FR\| ADULTES" or "NL\| VOLWASSENEN" weren't recognised, and an empty category answer unmarked titles | #71; Live TV #82 |
| 3   | Medium-low | A paused movie played after two quick skips or track changes                                                                               | #72              |
| 4   | Low-medium | After the five-minute release, a skip or track change while paused held the provider's connection                                          | #72              |
| 5   | Low-medium | A TMDB miss when details first opened lasted the session, even after adding a key                                                          | #77              |
| 6   | Low-medium | A series' details never showed episodes added by a refresh                                                                                 | #77              |
| 7   | Low-medium | The 4K tab resumed the HD version when the 4K one was listed first                                                                         | #75              |
| 8   | Low-medium | A failed Check now took Download away from an update on offer                                                                              | #64              |
| 9   | Low-medium | Settings > General showed old sound and subtitle languages after a pick in the player                                                      | #68              |
| 10  | Medium-low | A second copy of the app on the same profile overwrote the first's preferences                                                             | #66              |
| 11  | Low        | Keys reached a playing movie while its Sound menu was open                                                                                 | #69              |
| 12  | Low        | A paused title saved its progress every minute                                                                                             | #72              |
| 13  | Low        | "(ENG SUB)" read as English sound                                                                                                          | #67              |

Read in the code: `updates.json` dropped keys it didn't know, fixed in #64. Found while fixing removal: titles for adults pushed others out of Continue watching, fixed in #61.

Slice 5's known gaps:

| Gap                                                       | Disposition                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Use on the Mac and Windows with a real subscription       | Accepted by Wout on 2 October 2026, with Linux ([acceptance](#acceptance))                                                   |
| CEA-708 captions                                          | Tracked: no lawful fixture that carries CEA-708 alone                                                                        |
| Generated subtitle fixtures only                          | Tracked: needs lawful real samples                                                                                           |
| Subtitles after a skip                                    | Partly verified: a skip within what's loaded draws at once. A skip that starts a new run is still a [known gap](#known-gaps) |
| Another live sound track restarts the channel             | Existing behaviour by design (`apps/desktop/src/renderer/src/player/player.ts`)                                              |
| Text subtitles dimmer under the controls                  | Still open, with a proposed follow-up                                                                                        |
| Picking Captions cleared the remembered subtitle language | Fixed in #72                                                                                                                 |
| Resuming a picked version from Continue watching          | Verified in the app                                                                                                          |
| A finished series stayed in Continue watching             | Fixed in #79, which records a finished series                                                                                |
| The provider's connections and expiry                     | Tracked: needs Wout's subscription                                                                                           |
| Windows signing                                           | Deferred, as [decided](#decisions)                                                                                           |

## Pull requests

| Part                                 | Pull requests                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This record and the Store runbook    | #48, #93 and this update                                                                                                                                                                            |
| 1. Review and Continue watching      | #55 removes every version and shows it; the review's findings in #61, #64, #66, #67, #68, #71, #72, #75 and #77                                                                                     |
| 2. Automatic next episode            | #79, and #84 holds the countdown while Settings is open                                                                                                                                             |
| 3. Live quality variants             | #65                                                                                                                                                                                                 |
| 4. Episode details                   | #51 asks TMDB about a season when it opens, #58 shows the rows                                                                                                                                      |
| 5. Everyday controls and navigation  | #69 speed, subtitle timing and look, and modal menus; #78 the mini player; #83 the system's media controls                                                                                          |
| 6. Privacy and credential protection | #50 no spellcheck download, #52 no updater install id, #53 no login over http after https, #56 https first, #60 and #63 the policy and audit, #73 deleting the viewing record with the subscription |
| 7. Licences and launch obligations   | #54 Chromium's credits on the Mac, #59 the app's own licence and the build's commit, #62 the readiness record, #74 ffmpeg's toolchain and kept sources; #71 and #82 for content for adults          |
| 8. MSIX and Store-aware updates      | #57 the package, #70 Store updates and a separate data folder                                                                                                                                       |
| 9. Microsoft setup and submission    | #49 the wizard and the identity. Submission 1 happened in Partner Center and is recorded in the [runbook](../microsoft-store.md#submission-1)                                                       |
| 10. Acceptance and documentation     | #93 and this record; #96 the measurements. Wout's acceptance on 2 October 2026                                                                                                                      |
| Added: login-free playlists          | #81                                                                                                                                                                                                 |
| Added: the Nightly channel           | #87 offers nightlies only                                                                                                                                                                           |
| Added: a nightly before stable       | #88, and #94 lets that nightly be promoted later                                                                                                                                                    |
| Added: the update feed               | #90 names the highest nightly, #92 gives each Pages deploy its own artifact                                                                                                                         |
| Added: series                        | #89 one row per episode when the provider lists two files, #91 details as soon as the provider answers                                                                                              |
| Tests and reliability                | #76 the diagnostics log flushes on disposal; #80, #85, #86 and #95 steady four flaky tests                                                                                                          |

## Releases

- Nightly `0.0.4-nightly.20261002.110`, from `3cfa1e3` (run 36990279380), carries #48 to #84. Wout tested it and chose it for Stable.
- [Stable 0.0.4](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.4), published on 2 October 2026 by run 36998968726, rebuilt `3cfa1e3`. It was the first stable run to publish a nightly first (#88): `0.0.4-nightly.20261002.117`, from `b57faf1`, with #85 to #89. The stable release's feed deploy then failed, because both publications uploaded a Pages artifact with the same name. Running Update feed by hand (run 37000310982) put stable 0.0.4 and nightly .117 in the feed, and #92 fixed the names.
- The same run built package `1.0.4.0` from `3cfa1e3`. The Windows App Certification Kit passed it overall, and it is Store submission 1.
- [Stable 0.0.5](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.5), published on 2 October 2026 from `9040bb1`, carries #48 to #93. Wout tested that commit in a local build of `main` and as nightly .122. It went out as nightly `0.0.5-nightly.20261002.122` (run 37008249096), then stable run 37009048597, which published no nightly first because .122 already had `main`'s commit. The feed names stable 0.0.5 and nightly .122.
- The 0.0.5 run built package `1.0.5.0`; the certification kit passed it overall. It is Store submission 2, the test of a Store update that keeps the data.
- After 0.0.5: #94 lets a stable run promote a nightly that was published first, when it holds the stable commit; #95 steadies a test whose held stream the garbage collector cancelled; #96 adds the measurements below.

## Evidence

- Every pull request passed CI, and ran locally whichever of `pnpm knip`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` and `pnpm test` its change touched. The suite grew from 261 tests at the baseline to 395 on `1544904`, after #92.
- `release dry run` on #54, #57, #59, #70, #74 and #88 passed every job: the Mac app signed, notarized and checked, and the packaged-app test on the DMG, the NSIS install, the deb, the AppImage, and from #57 on the installed MSIX. The MSIX job installs a test-signed copy as the reserved package family name, runs the certification kit, which passes overall with only the optional "Blocked executables" test failing, and checks that uninstalling removes its data. Since #74 the packaged-app test opens Chromium's and Node.js's notices on every platform, and since #70 it checks which updater each build names.
- Each viewing change was driven in a Linux development build under Xvfb against the fake provider and fake TMDB, by pointer and keyboard. The pull requests list the steps and results.
- On the workbench Mac mini, #54's signed dry-run app returned Chromium's credits and Node.js's licence through the call About makes; 0.0.3 failed there.
- iptv-org, from a server in France: 20 of 21 channels played over https and http, HLS and MPEG-TS, and all five channels of the reviewers' list played (#81).
- Wout's subscription, from the gitignored `.local/` on the workbench: NCIS's 520 files gave 502 episode rows (#89), and #91 timed the details of five large series with a delayed fake TMDB.
- The privacy audit traced the sockets, Chromium's net log and the main process's requests of a fresh profile (#60).
- Data written by this slice stays readable by Stable 0.0.3: its own viewing record and preferences code ran on folders written by #55, #65 and #79, and the 0.0.3 AppImage on a playlist's profile showed Connect and changed nothing but its log (#81).

## Measurements

`apps/desktop/test/e2e/measure-app.ts`, with #96's additions, compared Stable 0.0.3 (`d87f835`), the released 0.0.4 (`3cfa1e3`) and `main` at `1544904`, the same app source as 0.0.5, built locally with 0.0.4's ffmpeg. It ran against the fake provider, with TMDB on a closed port, so details timings cover the provider only. The builds took turns each round: 5 rounds on the workbench Mac mini (M4), 10 on the VPS with the AppImage under Xvfb. Medians in ms unless marked:

| Measure                        | Mac 0.0.3 | Mac 0.0.4 | Mac `main` | VPS 0.0.3 | VPS 0.0.4 | VPS `main` |
| ------------------------------ | --------- | --------- | ---------- | --------- | --------- | ---------- |
| Cold start to Home             | 441       | 450       | 449        | 1881      | 1820      | 1802       |
| Time to picture                | 1027      | 1028      | 1028       | 1356      | 1330      | 1338       |
| Channel switch                 | 773       | 775       | 775        | 1243      | 1053      | 1060       |
| Guide open                     | 21        | 22        | 23         | 59        | 46        | 51         |
| Guide list of 13,000           | 16        | 14        | 17         | 31        | 25        | 29         |
| Search                         | 258       | 259       | 259        | 273       | 269       | 273        |
| Long series, name shown        | 77        | 76        | 26         | 299       | 280       | 48         |
| Long series, episodes shown    | 77        | 76        | 75         | 300       | 280       | 311        |
| Idle CPU, Home with preview    | 18.4%     | 19.0%     | 18.4%      | 47%       | 44%       | 42%        |
| Idle CPU, Home stopped         | 0.2%      | 0.7%      | 0.6%       | 1.4%      | 1.2%      | 1.4%       |
| Memory, Home with preview (MB) | 851       | 859       | 855        | 970       | 948       | 948        |
| Memory, Home stopped (MB)      | 842       | 851       | 845        | 821       | 831       | 823        |
| Installed size (MB)            | 261       | 280       | 279        | 297       | 297       | 297        |

Nothing reaches the warning line of `compare-builds.ts` ([testing](../../contributing/testing.md#app-measurements)): more than 10% worse and beyond the noise of 20 ms, 1 CPU point or 10 MB. A long series shows its name at once (#91), from 77 to 26 ms on the Mac and 299 to 48 ms on the VPS; its episodes still wait for the provider. #91's gain with a slow TMDB isn't exercised here. The Mac's installed size grew 19 MB with Chromium's credits (#54). Idle CPU with Home stopped (+0.4 to 0.5 points) and memory (+3 to 9 MB) moved within noise. The VPS's channel-switch drop is noise; the Mac's stayed flat.

Every build opens one stream per switch and none from Home to Watch. Tuning opens two for channels with MP2 or MP3 sound in every build, 0.0.3 included; the likely cause is a retry after a refusal while the fake provider frees its slot, unconfirmed.

Caveats: the Mac had another agent's screen capture and an installed app running (load about 2), and the VPS is shared.

## Acceptance

On 2 October 2026 Wout tested, on the Mac, Windows and Linux: nightly `0.0.4-nightly.20261002.117` from `b57faf1`, then nightly `0.0.5-nightly.20261002.122` from `9040bb1`, the release code of Stable 0.0.5, besides a local build of `main` at that commit. He accepted them, with no failures reported. That is his overall acceptance; no result per check is recorded.

Windows Store: submission 1, `1.0.4.0`, was published to the private audience and installed on Wout's PC from the testers' link, and it worked.

Still to do, on Windows:

- The Store update: submission 2, 0.0.5 as `1.0.5.0`, through the Store, keeping the login, preferences, favourites and progress, and never running the EXE updater.
- The Store copy beside the direct EXE, each keeping its own data.
- General > Updates in the Store copy: the one row, "updated by the Microsoft Store", and Open Store opening the product page.

The [privacy audit's open checks](../privacy-audit.md#open-checks) list what is still worth looking at on the Mac and Windows: the data folder after a session, crash reports and what uninstalling leaves.

## Known gaps

Viewing:

- **Subtitles under the controls.** Text subtitles look dimmer while the controls and their gradient show. Proposed follow-up: draw text subtitles in the app's own layer above the controls, as picture subtitles already are.
- **Subtitles after a far skip.** A skip that starts a new run shows picture subtitles, teletext and captions again only from their next change.
- **Live DVB picture subtitles** weren't seen on a real channel. The fake channel's 4 s clip reconnects each time it ends, so pictures were checked on a PGS film.
- **CEA-708 captions** still show nothing when a stream carries no CEA-608. Supporting them needs a lawful fixture first.
- **System controls on a stopped channel.** Pausing a channel from the system's controls stops it, and only Watch in the app starts it again.
- **Two files of an episode.** #89 picks the file whose marks suit the viewer's language, then the newest. That can be an HEVC file, which Windows converts on the CPU.
- **Season details wait for the series.** A season's TMDB request starts only after the series' details, when it needs the series' own language (#91).
- **Real TMDB timing** is unmeasured. #91's timings used the fake TMDB with fixed delays, and #51's localized "Episode 3" names are an assumption.
- **Original language in details.** The review traced, without testing it, that a title's details ignore TMDB's original language (`packages/core/src/ondemand/details.ts`).
- Another live sound track restarts the channel, a moment's break, by design.
- No real broadcast with teletext or captions, and no real Blu-ray PGS, has been played.
- The provider's connections and expiry in Settings > Subscription are unchecked against a real provider.

Playlists (#81):

- A playlist without a guide shows "Something went wrong: This playlist names no guide." when its Guide row is refreshed.
- A lost keychain item still says "Enter your password again", where a playlist needs its link.
- HLS channels have no Sound or CC menus: they play the default sound, without subtitles.
- The reviewers' five channels were checked from France, not from the US.

Privacy, release and platform:

- The viewer's own TMDB key stays in plain text in `preferences.json`, disclosed in the policy. Sealing it would make 0.0.3 lose the key after a return to Stable.
- The Windows ffmpeg build uses MSYS2's MINGW64 environment, which MSYS2 deprecates (warning in run 36990279380). Move to UCRT64 or CLANG64 later, and update the toolchain record in ffmpeg's `README.txt`.
- The very last diagnostics lines can still be lost at quit, which doesn't wait for the runtime to close (#76).
- A server that drops packets on port 443 keeps "Connecting…" up for the 15 s login timeout before the http question appears (#56).
- Windows signing of the direct download stays deferred, as [decided](#decisions).
- The open launch gates, Belgian publisher classification and the Chromium source question among them, are in the [release readiness record](../release-readiness.md).
