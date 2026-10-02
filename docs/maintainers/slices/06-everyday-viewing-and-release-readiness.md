# Slice 6: everyday viewing and release readiness

Status: handoff prepared on 2 October 2026 at Wout's request; implementation under way. How Microsoft treats HTTP credential transport and the dedicated adult tab is still to be clarified, and a Store submission waits for it; work that doesn't depend on the answer goes ahead. [Pull requests](#pull-requests) lists each part's PR and [known gaps](#known-gaps) what remains open.

Outcome: comfortable daily viewing on the Mac and Windows, verified Linux packages, and a documented, tested path to a Windows Store build distributed privately. Mr. Streamer stays a free, open-source player for the user's own subscription. The public Store launch waits for the base release's acceptance.

## Start here

- How it works: [architecture](../architecture.md), [testing](../testing.md), [releasing](../releasing.md), [signing](../signing.md), and slice 5's [known gaps](05-tracks-languages-and-details.md#known-gaps), carried below.
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

The [runbook](../microsoft-store.md) has the exact checklist. The steps only Wout can take get a resumable wizard: verifying his personal Microsoft account, accepting the Partner Center agreements, reserving the name and setting up the private test audience. Build and configure everything an agent can do first, and never ask for identity documents, passwords or secrets in chat. The slice prepares and assists the first manual private submission, and tests a real install and update from the Store once the account and certification steps are done. The existing nightly and stable policy and the cumulative stable notes don't change.

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

- **HTTP-only providers.** Keep HTTP compatibility, make the risk clear and leave the choice of provider with the user. Before submitting, check Microsoft's secure-transmission requirement against the actual credential flow. If certification demands a restriction, bring the finding and the distribution options to Wout; don't change the agreed behaviour quietly or claim that the user's responsibility waives the policy.
- **Dedicated adult tab.** Clarify Microsoft's policy first, and leave the tab out of the Store package only if needed and Wout agrees. Keep ordinary mature-rated films apart from prohibited explicit content. Neither this approach nor a generic-player disclaimer guarantees Store approval.
- **Setup inputs.** The publisher identity and contact, the testers' Microsoft account addresses and the host of the public legal page are inputs to setup, not reasons to stop independent work. Personal verification data and credentials stay out of this record.

## Deferred

- M3U and XMLTV subscription import, in its own slice after the base release.
- Multiple subscriptions, mobile and TV apps, downloads and trailers.
- The marketing landing page, the public Store listing and Store submission automation, in the launch and distribution slice after the base roadmap.
- Interface translation, apart from the existing content-language controls.

## Policy references

Checked on 2 October 2026. Check the policies in effect again before submitting.

- [Microsoft Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies), privacy, security, content, testability and ratings included. Version 7.19 is in effect; the published 7.20 takes effect on 22 October 2026.
- [TMDB FAQ](https://developer.themoviedb.org/docs/faq) and [JustWatch attribution](https://developer.themoviedb.org/reference/tv-series-watch-providers).
- [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) and [FFmpeg's legal guidance](https://ffmpeg.org/legal.html).
- The Belgian [Data Protection Authority's guidance](https://www.dataprotectionauthority.be/professionnel/premiere-aide/toolbox), [FPS Economy's publisher information](https://economie.fgov.be/nl/themas/online/elektronische-handel/verkoop-internet/bedrijfswebsite-en-accounts-op) and the [BOIP register](https://www.boip.int/en/trademarks-register).

## Pull requests

| Part                                 | Pull request |
| ------------------------------------ | ------------ |
| This record and the Store runbook    | Planned      |
| 1. Review and Continue watching      | Planned      |
| 2. Automatic next episode            | Planned      |
| 3. Live quality variants             | Planned      |
| 4. Episode details                   | Planned      |
| 5. Everyday controls and navigation  | Planned      |
| 6. Privacy and credential protection | Planned      |
| 7. Licences and launch obligations   | Planned      |
| 8. MSIX and Store-aware updates      | Planned      |
| 9. Microsoft setup and submission    | Planned      |
| 10. Acceptance and documentation     | Planned      |

## Known gaps

Carried from [slice 5](05-tracks-languages-and-details.md#known-gaps), each to be dispositioned in part 1:

- **Use on the Mac and Windows:** slice 5 ran against the fake provider. Windows ran only the release workflow's packaged-app test on a hosted runner, and the Mac checks ran on a development build. No use of the signed Mac app or the Windows nightly on a real subscription is recorded: live subtitles and Sound on a real channel, picture subtitles from a real Blu-ray rip, track changes while paused, versions, Settings, and an upgrade from the nightly before. The green button wasn't pressed by hand.
- **CEA-708 captions** are left out: the decoder reads CEA-608, which most broadcasts with captions also carry. A channel or file that sends captions only as CEA-708 shows none. Supporting them needs a real fixture first.
- The subtitle fixtures are generated: no real broadcast with teletext or captions, and no real Blu-ray PGS, has been played.
- After a skip, picture subtitles, teletext and captions already on screen show again only from their next change; live subtitles turned on show from the next line.
- Another live sound track starts the channel again, a moment's break.
- Text subtitles look dimmer while the controls, and the gradient behind them, show.
- Picking Captions, which have no language, clears the remembered subtitle language.
- Resuming a picked version from Continue watching was not driven end to end: the test clips are shorter than the two minutes a title needs to count as started.
- Continue watching can't tell a series is finished until Next episode finds nothing after the last episode.
- Connections in use and expiry come from the provider when Subscription opens; a real provider's numbers haven't been checked.
- Windows signing stays deferred, now as a [decision](#decisions).
