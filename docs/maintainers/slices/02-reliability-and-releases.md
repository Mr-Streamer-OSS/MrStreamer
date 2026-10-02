# Slice 02: reliable playback and releases

Status: complete on 29 September 2026. Built in pull request #1 (`53437e3`) and the reliability fixes in #2. The first nightly, `0.0.1-nightly.20260929.12`, was published that day, and Stable 0.0.1 on 30 September from nightly `.15`'s commit (`263950b`). [Known gaps](#known-gaps) lists what this slice left open; [slice 03](03-live-tv-and-guide.md) carries on.

Outcome: play a broader, verified set of the selected subscription's streams on Mac, Windows and Linux; preserve usable data through refreshes and normal upgrades; prepare nightly or stable releases; update from inside the app or through a downloaded installer.

## Start here

- The repository is `Mr-Streamer-OSS/MrStreamer`, public since 29 September 2026; `main` holds this slice.
- Releases come from `.github/workflows/release.yml`; [releasing](../releasing.md) describes the process. Nightlies publish automatically; Wout starts Stable releases.
- Use the existing modular boundaries. Keep provider access, library state, playback, platform installation/signing and UI responsibilities separate. Reuse work that already satisfies the contract.

## Progress

Recorded 29 Sep 2026. Measurements and their method are in the [playback evaluation](../../contributing/playback-evaluation.md).

| Task                      | State                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 02.1 Baseline             | Done. Repository at `Mr-Streamer-OSS/MrStreamer`, public since 29 Sep, `main` at `06b2298` when work began. App id now `app.mrstreamer.player`; the data folder is unchanged.                                                                                  |
| 02.2 Playback             | Done. Chromium plus a bundled ffmpeg chosen and built. All 14 real-stream samples play on the M4 Mac; Linux verified functionally; Wout checked Windows on his PC.                                                                                             |
| 02.3 Library              | Done. Failed, empty and short refreshes keep the last catalogue, including an empty confirming fetch (#2); tests cover them.                                                                                                                                   |
| 02.4 Visuals              | Done. Option B for the DMG and the update flow.                                                                                                                                                                                                                |
| 02.5 Releases and signing | Done. Signing, notarization and stapling pass in every release run. Nightly eligibility, Stable promotion, the shared bundle and version records are built and tested; dry runs passed on all three platforms, and queued runs waited without being cancelled. |
| 02.6 Updates              | Done. In-app update and data preservation verified on Linux (AppImage, and the deb in a container). #2 made retries, cancelling at every step and channel switches reliable, and finds Stable behind any number of nightlies.                                  |
| 02.7 Back to Stable       | Done. Start fresh verified on Linux (AppImage). Since #2, Stable erases the data when it first starts, so a refused or interrupted install keeps it. Removed after the slice (#3): choosing Stable keeps the data.                                             |
| 02.8 Docs                 | Done. README, user guides, maintainer guides, CONTRIBUTING, security contact, PR and issue templates.                                                                                                                                                          |
| 02.9 Acceptance           | Done. Wout checked the Mac and Windows installs; the first nightly passed every release check.                                                                                                                                                                 |

### Known gaps

- Updating from `0.0.1-nightly.20260929.12` to the next nightly through the real feed on Mac and Windows: Wout reported on 30 September that his Mac and Windows testing worked (user-reported).
- Playback measurements on a Windows PC and on a Linux desktop with a GPU; the evaluation has Mac numbers only.
- A damaged broadcast takes about 12 s to start while it's re-encoded; the user guide states it.
- Movie and episode samples were not part of the engine evaluation; libmpv stays the option when their slice needs it.

Decisions changed since scoping, by Wout:

- Release policy updated again on 29 September: automatic nightlies, and Stable by manual promotion of the latest published nightly's commit. The earlier stable-draft and next-minor-bump behavior is superseded; see 02.5.
- The first release is 0.0.1.
- Wout made the repository public on 29 September, before the first release.
- After the slice, on 29 September: Start fresh on Stable is removed. Choosing Stable on a nightly build offers the newest stable release, older or not, and keeps the data.
- The app id moved to `app.mrstreamer.player`, on Wout's `mrstreamer.app` domain: a clean start, since nothing was released under the old id. It has no hyphens, so Android and iOS accept it too. The Linux package, executable and Windows install folder are now `mrstreamer`.
- The development mock provider and other investigation tooling left the source; tests keep a small fake provider.
- ffmpeg builds inside each release packaging job, not in a separate job.
- Commits are authored as Wout Stiens with his GitHub no-reply address.

## Agreed product decisions

- One desktop app supports Mac, Windows and Linux. It has Stable and Nightly distribution channels with shared local data.
- Automatic nightlies with a six-hour minimum gap and new commits, plus manual Stable promotion of the latest published nightly's exact commit. Manual nightly dispatch remains available. See 02.5.
- Publish complete releases only after all required checks and platform artifacts pass. Nightlies publish as prereleases; Wout starts Stable promotion after testing the nightly. Use a separate maintainer dry run for artifact testing without publication.
- Mac ships as a direct-download DMG. Wout has paid Apple Developer membership. Configure Developer ID signing, notarization and ticket stapling; redesign the DMG window.
- Windows signing is deferred. Keep a clear signing step that can be enabled later without restructuring the release process.
- Preserve the Linux AppImage and DEB delivery paths established in slice 01. Inspect final build configuration for the actual architecture and OS matrix rather than assuming new targets.
- The user starts an update in the app, then separately confirms restarting once it is ready. Never force a restart during playback. Downloading and installing a newer package manually must also preserve normal user data.
- Broader codec and stream compatibility is required. A bundled playback engine is authorized if the evaluation demonstrates an improvement. Users should not need a separate player or codec installation.
- Failed catalogue refreshes retain the last working catalogue. Successful refreshes and normal app updates preserve subscription setup, preferences and watch history.
- Separate user documentation from maintainer/agent documentation before public launch. While the project is being built out, accept only small bug-fix contributions; feature contributions, broad refactors and larger changes are not currently accepted.

## Ordered tasks

### 02.1 Establish the baseline and repository destination

- [x] Record the completed slice 01 revision, installer artifacts, passed checks and unresolved acceptance gaps. Recheck the subscription mutation race and catalogue error-state fixes only as needed from the final evidence.
- [x] Confirm Wout has completed the transfer into Mr-Streamer-OSS. Discover the actual repository URL and default branch, update the working checkout's remote when appropriate, and use the new destination consistently.
- [x] Inspect repository access, Actions permissions and build routes after transfer. Preserve the app identity and data location across the move; changing the GitHub owner must not create a new empty app profile.
- [x] Identify representative failing streams from the selected subscription through private local configuration. Keep credentials and credential-bearing stream URLs out of logs, release notes and published evidence.
- [x] Establish practical test access to the target Mac, Windows and Linux systems. Read the mac-mini skill when using the workbench Mac for builds, signing or device verification.

Done when: the baseline and remaining failures are recorded; playback samples and device test routes are available; the new repository destination is verified before release setup starts. If the transfer is pending, report that dependency and continue independent tasks.

### 02.2 Prove the playback engine and package it

- [x] Diagnose the failing samples. Separate unavailable or unstable provider streams from format, demuxing, decoding and audio failures. Increasing a timeout is not codec support.
- [x] Compare the current Chromium-based player with a bundled engine candidate such as libmpv. Select from measured results; libmpv is not a predetermined implementation.
- [x] Build a reproducible sample matrix from actual failures and the existing mock streams. Include relevant HEVC, MPEG-2, AC-3 and MP2 cases alongside the working H.264/AAC baseline. Include representative movie and episode samples for engine evaluation without adding their browsing UI.
- [x] Verify picture and sound, repeated switching, stale-response handling, connection release, stop, volume and full screen on all three platforms. Check subtitles and seeking on samples where applicable.
- [x] Measure startup, switching, CPU, memory and hardware/software decoding behaviour. Record numerical acceptance budgets after baseline measurements and explain any tradeoffs.
- [x] Prove that the candidate renders within the existing app UI and ships in each installer. Check bundled dependency distribution requirements, architecture support, size and compatibility with Mac signing/notarization.
- [x] Implement the selected engine behind the existing playback boundary. Retain fallback paths only where evidence justifies them. Report unsupported formats promptly and distinguish them from network failures when the cause is known.

Done when: documented results support the engine choice on Mac, Windows and Linux; agreed previously failing cases play with sound; unsupported cases are explicit; packaged integration and existing player controls work. Error-copy improvements alone do not complete this task.

### 02.3 Complete library reliability

- [x] Reuse the existing normalization, cache and refresh work. Identify remaining gaps against the user-visible contract.
- [x] Preserve the last working catalogue after failed, partial or interrupted refreshes. A failed update must not replace it with incomplete data.
- [x] Preserve preferences and watch history across successful refreshes. Provider IDs should retain channel associations across display-name or order changes where those IDs remain stable.
- [x] Handle removed channels deliberately and keep saved user state from breaking browsing. Show understandable loading, failure and retry states.
- [x] Verify browsing and name search against a realistic catalogue while a stream plays and the catalogue refreshes.

Done when: focused behavioural checks cover successful and failed refreshes, restart persistence and responsive browsing during playback. Reuse passing slice 01 checks rather than duplicating them.

### 02.4 Review visual options

- [x] Publish distinct DMG-window options before implementation. Include the branded background, window dimensions, icon positions and clear drag-to-Applications instruction.
- [x] Present channel selection, update progress, restart confirmation and destructive clean-stable confirmation as reviewable UI options before editing real components.
- [x] Obtain Wout's selection, then implement the selected designs. Follow the approved black background, white primary text, minimal copy and uncluttered layout.

Done when: Wout has selected the visual direction and the actual DMG and app flows match it. The existing large-backdrop viewing direction remains the product reference.

### 02.5 Automatic nightlies, Stable promotion and Mac signing

Updated by Wout on 29 September 2026: automatic nightlies, and manual promotion of the latest published nightly's exact commit to Stable. This supersedes the earlier manual-only and stable-draft policies. [Releasing](../releasing.md) documents the result.

| Area                  | Required change                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic nightlies   | Check every 30 minutes; build when there are new commits and at least six hours have passed since the last published nightly. Keep manual nightly dispatch                         |
| Stable release source | Rebuild the exact commit of the latest published nightly: resolve its tag to the commit, verify default-branch ancestry and carry that SHA through the entire run                  |
| Publication           | Publish only after all required checks and packages succeed. A nightly is a prerelease; a manually requested Stable becomes the latest release, not a draft                        |
| Shared build          | Build the platform-independent JavaScript once and reuse the versioned bundle for Mac, Windows and Linux; retain platform-specific FFmpeg builds, signing and installed-app checks |
| Version bookkeeping   | Nightlies preview a future stable version. Record the released stable version after publication instead of an automatic minor bump; document overrides, retries and ordering       |
| Branch testing        | Keep an artifact-only release dry run outside the update feeds; no third user-facing channel                                                                                       |

- [x] Keep ordinary PR/main CI and release verification consistent, with required checks on the exact source being shipped.
- [x] Resolve the release source before checks or builds. Manual Stable selects the most recently published valid nightly, ignoring drafts and unrelated prereleases, and derives its default version from that nightly. A version override must not change the selected source commit. Resolve annotated tags correctly and reject missing nightlies or commits outside the default branch.
- [x] Pin every checkout, check, bundle, installer, release note and release target to that resolved SHA. Advancing `main` during a run must not change its contents. A stable promotion rebuilds the same source with a stable version; it does not reuse nightly-labelled binaries.
- [x] Check nightly eligibility every 30 minutes. Require at least six hours since the previous published nightly and new commits descended from it. Evaluate this after acquiring the nightly concurrency lock. Manual nightly dispatch may bypass the interval. Handle the first nightly, unchanged history and divergent history explicitly.
- [x] Serialize publications without cancelling active releases or silently dropping requested Stable runs. Keep nightly and stable queues independent, and check duplicate tags and release ordering before publication.
- [x] Build the shared JavaScript bundle once with the resolved release version. Package it on the existing Mac arm64, Windows x64 and Linux x64 runners. Retain required tests, FFmpeg caching/builds and installed-app checks; do not add other architectures or infrastructure without a project need.
- [x] Publish only after every required check, platform build, signing check and artifact validation succeeds. Attach installers, updater metadata, checksums, dependency source archives and notes tied to the resolved commit. Mark nightlies as prereleases without replacing latest stable; mark promoted Stable as latest. Define safe recovery from a failed or repeated publication.
- [x] Record the released stable version only after successful publication, derive the next nightly target without requiring an automatic minor bump, and prevent duplicate or backwards versions when finalization is delayed. Document any repository permissions needed for finalization and its recovery path.
- [x] Retain a maintainer dry run that exercises packaging and signing without publishing to either update channel. Keep branch artifacts out of normal updater feeds. Limit signing credentials to trusted runs; fork PR checks must not require release secrets.
- [x] Add focused behavioral tests for source selection, version ordering and publication eligibility: first nightly, six-hour boundary, unchanged/divergent history, drafts and unrelated prereleases, manual Stable promotion while `main` advances, missing nightly, and duplicate versions.
- [x] Verify failure gates and cancellation/queue behavior in a dry run.
- [x] Update `docs/maintainers/releasing.md` and related maintainer guidance for the final workflow, including manual Stable promotion, nightly timing, overrides, dry runs, publication recovery and first-release setup.
- [x] Preserve Developer ID signing, hardened runtime, notarization and ticket stapling using Wout's paid membership. Walk Wout through any remaining account, local Mac and GitHub Actions setup; guide only the steps he must perform himself. Missing required signing inputs or failed notarization must fail a release build.
- [x] Include the updater ZIP alongside the Mac DMG. Keep Windows unsigned with an isolated path to enable signing later. Preserve Linux AppImage and DEB delivery.
- [x] Verify the redesigned downloaded DMG, Windows installer and Linux packages on target systems. Record the exact build, source SHA and results, including installation and launch without development tools or a UI server.

Done when: automatic nightlies and manual Stable promotion follow the agreed source and publication policy; all release artifacts come from one verified revision; dry runs cannot reach user update feeds; Mac signing/notarization and the supported packages pass verification. Keep the repository private during the slice. Wout controls the first public launch; do not trigger releases or change visibility just to complete this checklist.

### 02.6 Deliver user-initiated updates and channels

- [x] Add one Stable/Nightly selector to the app. A downloaded build establishes its initial channel; persist explicit user changes. Show the installed version and selected channel.
- [x] Stable users receive stable releases only. Nightly users can receive newer nightly and stable releases. Keep their chosen channel when installing a stable version unless they explicitly change it.
- [x] Implement a user-started check/download flow with progress and useful failure/retry states. Require a separate restart confirmation after the update is ready. Playback continues until the user chooses to restart.
- [x] Verify that normal in-app upgrades and manual installation of a newer package preserve credentials, preferences and watch history across all supported package types.
- [x] Test updates during private development with controlled artifacts and an update feed. Ship no repository access token in the app. Prepare the final public GitHub destination for use once the project becomes public.

Done when: two real installed versions can update through the intended feed on each platform, channel filtering is correct, and both in-app and downloaded-package upgrades preserve data. Fresh-install tests alone are insufficient.

### 02.7 Implement both routes back to Stable

- [x] **Switch to Stable:** retain the installed version and data; receive a newer stable release when available. Explain when the installed nightly is ahead of stable. Do not silently downgrade it.
- [x] **Start fresh on Stable:** explicitly confirm deletion of local subscription credentials, preferences, watch history and catalogue cache, then install the latest stable even if older. Explain that the user must reconnect their subscription. This affects only this device's Mr. Streamer data, not the provider account or other devices.
- [x] Download and verify the stable payload before starting a reset. Cancelling or failing during download/preparation must preserve the current app and data.
- [x] Prove the installer/reset ordering on each platform. A confirmed completed reset starts Stable with clean local state; test interruption and a usable recovery path rather than assuming binary replacement and data deletion are atomic.

Done when: both routes work against a nightly newer than the available stable build; normal switching preserves data; only the explicitly confirmed clean path removes it; preparation failures do not reset anything.

### 02.8 Prepare user docs and the contribution policy

- [x] Make the public README the user entry point: what the app does, supported systems, where to download it, installation, connecting a subscription, everyday use and where to report bugs.
- [x] Put user instructions in a clearly separate user-documentation area. Explain Stable/Nightly channels, user-initiated updates, manual replacement, clean-stable reset, known playback limits and the current unsigned Windows installation experience.
- [x] Keep architecture, local development, test fixtures, signing setup, release operations, agent handoffs and slice task lists in maintainer/agent documentation. Link that area from a development section rather than placing internal instructions in the main user journey. Update cross-links when moving existing material.
- [x] Add a clearly linked contribution policy, such as CONTRIBUTING.md, stating that during active build-out only small bug-fix contributions are accepted. State that feature additions, broad refactors and other large contributions are not currently accepted. Apply the same rule in any contribution instructions or PR template so contributors see it before investing work.
- [x] Review documentation intended to ship publicly for private provider examples, credentials and environment-specific access details. Use safe examples and make user instructions work without access to the maintainer's infrastructure or planning tools.

Done when: a new user can find install/use/update guidance without reading agent tasks; a maintainer can find build/test/release instructions; the temporary small-bug-fix-only contribution policy is explicit and easy to find. Check documentation against the actual packaged workflows.

### 02.9 Record acceptance and the public-release handoff

- [x] Run the completed viewing, catalogue refresh, install and upgrade workflows on Mac, Windows and Linux. Record build/version, OS, architecture, package type, results and material limitations.
- [x] Exercise an unavailable stream, connection interruption, failed refresh, cancelled/failed update and interrupted installation. Verify recovery without unrequested data deletion.
- [x] Verify release-channel routing, manual replacement, data preservation, clean-stable reset and the actual Mac download/install/launch experience.
- [x] Record remaining setup or device gaps honestly. A Linux headless run does not establish Mac or Windows acceptance, and mock streams do not establish compatibility with the selected subscription.
- [x] Prepare Wout's public-release handoff: first good release candidate, release notes, artifact locations, user documentation, the contribution policy and the public feed verification to perform after visibility changes.

Done when: acceptance evidence supports closing slice 02 and the first public release can be reviewed. Wout makes the repository public and publishes that release after the slice; those actions are not automatic completion steps for this agent.

## Scope boundaries

Additional provider types, generic M3U/XMLTV source management, multiple subscriptions, full EPG, movie/series browsing, mobile/TV and external metadata enrichment remain later work. Windows signing, app stores, hosted UI and additional desktop architectures remain outside this slice. Scheduled nightly publishing and manual Stable promotion are now required under 02.5. A tag-triggered Stable shortcut, hosted deployments and a third user-facing channel are not required.

Do not promise every possible codec or feed. Establish a representative sample set, demonstrate improvement on the supported platforms and record remaining limits. Engine choice and platform installation details are investigations; the agreed product behaviour above is settled.

## References

- [Planning and roadmap](../README.md)
- [Mr-Streamer-OSS organization](https://github.com/Mr-Streamer-OSS)
- [Apple Developer ID distribution](https://developer.apple.com/developer-id/)
- [electron-builder update targets and metadata](https://www.electron.build/v26/docs/features/auto-update/)
- [libmpv embedding](https://mpv.io/manual/stable/#embedding-into-other-programs-libmpv)
