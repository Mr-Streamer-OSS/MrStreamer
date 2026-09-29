# Slice 02: reliable playback and releases

Status: in progress on pull request #1 (not merged). Playback conversion, catalogue safeguards, Mac signing, CI, the release workflow, in-app updates, both routes back to Stable and the documentation split are built and tested; see [Progress](#progress) for what remains.

Outcome: play a broader, verified set of the selected subscription's streams on Mac, Windows and Linux; preserve usable data through refreshes and normal upgrades; prepare nightly or stable releases; update from inside the app or through a downloaded installer.

## Start here

- Read the latest slice 01 changes and acceptance evidence before estimating or changing code. Another agent is finishing that work. Preserve its changes and use its completed build as the baseline.
- Wout will transfer the repository into **Mr-Streamer-OSS** after the latest slice 01 build is ready. The organization already exists. Verify transfer completion and the actual repository name before configuring release destinations, updater URLs or repository-bound credentials.
- Keep the repository private throughout slice 02. Wout intends to make it public for the first good release after this slice. Transfer, visibility changes and public release publication are actions for Wout or require his explicit instruction.
- Repository transfer blocks release-destination setup, not independent playback investigation, library work or design exploration.
- Use the existing modular boundaries. Keep provider access, library state, playback, platform installation/signing and UI responsibilities separate. Reuse work that already satisfies the contract.

## Progress

Recorded 29 Sep 2026. Measurements and their method are in the [playback evaluation](../playback.md).

| Task                      | State                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 02.1 Baseline             | Done. Repository at `Mr-Streamer-OSS/MrStreamer`, private, `main` at `06b2298` when work began. App id now `io.github.mr-streamer-oss.mrstreamer`; the data folder is unchanged.                                                           |
| 02.2 Playback             | Chromium plus a bundled ffmpeg chosen and built. All 14 real-stream samples play on the M4 Mac; Linux verified functionally; Windows smoke-tested on GitHub's runner. Open: measurements on the Windows PC and a Linux desktop with a GPU. |
| 02.3 Library              | Done: failed, empty and short refreshes keep the last catalogue; tests cover them.                                                                                                                                                         |
| 02.4 Visuals              | Option B chosen for the DMG and the update flow; both built.                                                                                                                                                                               |
| 02.5 Releases and signing | Signing, notarization and stapling pass in CI and on the Mac mini. Release dry runs pass on all three platforms, including installed-app smoke tests. Open: T3-aligned release policy and pipeline work in 02.5, then release acceptance.  |
| 02.6 Updates              | Built. In-app update and data preservation verified on Linux (AppImage); deb in a container, Mac and Windows open.                                                                                                                         |
| 02.7 Back to Stable       | Built. Start fresh verified on Linux (AppImage): Stable downloaded first, erase only after the tick, clean start on Stable.                                                                                                                |
| 02.8 Docs                 | README, user guides, maintainer guides, CONTRIBUTING, PR and issue templates written.                                                                                                                                                      |
| 02.9 Acceptance           | Open.                                                                                                                                                                                                                                      |

Decisions changed since scoping, by Wout:

- Release policy updated again on 29 September: adopt T3 Code's automatic nightlies and manual Stable promotion of the latest published nightly commit. The earlier stable-draft and next-minor-bump behavior is superseded; implementation work is listed in 02.5.
- The app id moved to the organization: a clean start, since nothing was released under the old id.
- The development mock provider and other investigation tooling left the source; tests keep a small fake provider.
- ffmpeg builds inside each release packaging job, not in a separate job.
- Commits are authored as Wout Stiens with his GitHub no-reply address.

## Agreed product decisions

- One desktop app supports Mac, Windows and Linux. It has Stable and Nightly distribution channels with shared local data.
- Follow T3 Code's release policy: automatic nightlies with a six-hour minimum gap and new commits, plus manual Stable promotion of the latest published nightly's exact commit. Manual nightly dispatch remains available. See 02.5.
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

- [ ] Record the completed slice 01 revision, installer artifacts, passed checks and unresolved acceptance gaps. Recheck the subscription mutation race and catalogue error-state fixes only as needed from the final evidence.
- [ ] Confirm Wout has completed the transfer into Mr-Streamer-OSS. Discover the actual repository URL and default branch, update the working checkout's remote when appropriate, and use the new destination consistently.
- [ ] Inspect repository access, Actions permissions and build routes after transfer. Preserve the app identity and data location across the move; changing the GitHub owner must not create a new empty app profile.
- [ ] Identify representative failing streams from the selected subscription through private local configuration. Keep credentials and credential-bearing stream URLs out of logs, release notes and published evidence.
- [ ] Establish practical test access to the target Mac, Windows and Linux systems. Read the mac-mini skill when using the workbench Mac for builds, signing or device verification.

Done when: the baseline and remaining failures are recorded; playback samples and device test routes are available; the new repository destination is verified before release setup starts. If the transfer is pending, report that dependency and continue independent tasks.

### 02.2 Prove the playback engine and package it

- [ ] Diagnose the failing samples. Separate unavailable or unstable provider streams from format, demuxing, decoding and audio failures. Increasing a timeout is not codec support.
- [ ] Compare the current Chromium-based player with a bundled engine candidate such as libmpv. Select from measured results; libmpv is not a predetermined implementation.
- [ ] Build a reproducible sample matrix from actual failures and the existing mock streams. Include relevant HEVC, MPEG-2, AC-3 and MP2 cases alongside the working H.264/AAC baseline. Include representative movie and episode samples for engine evaluation without adding their browsing UI.
- [ ] Verify picture and sound, repeated switching, stale-response handling, connection release, stop, volume and full screen on all three platforms. Check subtitles and seeking on samples where applicable.
- [ ] Measure startup, switching, CPU, memory and hardware/software decoding behaviour. Record numerical acceptance budgets after baseline measurements and explain any tradeoffs.
- [ ] Prove that the candidate renders within the existing app UI and ships in each installer. Check bundled dependency distribution requirements, architecture support, size and compatibility with Mac signing/notarization.
- [ ] Implement the selected engine behind the existing playback boundary. Retain fallback paths only where evidence justifies them. Report unsupported formats promptly and distinguish them from network failures when the cause is known.

Done when: documented results support the engine choice on Mac, Windows and Linux; agreed previously failing cases play with sound; unsupported cases are explicit; packaged integration and existing player controls work. Error-copy improvements alone do not complete this task.

### 02.3 Complete library reliability

- [ ] Reuse the existing normalization, cache and refresh work. Identify remaining gaps against the user-visible contract.
- [ ] Preserve the last working catalogue after failed, partial or interrupted refreshes. A failed update must not replace it with incomplete data.
- [ ] Preserve preferences and watch history across successful refreshes. Provider IDs should retain channel associations across display-name or order changes where those IDs remain stable.
- [ ] Handle removed channels deliberately and keep saved user state from breaking browsing. Show understandable loading, failure and retry states.
- [ ] Verify browsing and name search against a realistic catalogue while a stream plays and the catalogue refreshes.

Done when: focused behavioural checks cover successful and failed refreshes, restart persistence and responsive browsing during playback. Reuse passing slice 01 checks rather than duplicating them.

### 02.4 Review visual options

- [ ] Publish distinct DMG-window options before implementation. Include the branded background, window dimensions, icon positions and clear drag-to-Applications instruction.
- [ ] Present channel selection, update progress, restart confirmation and destructive clean-stable confirmation as reviewable UI options before editing real components.
- [ ] Obtain Wout's selection, then implement the selected designs. Follow the approved black background, white primary text, minimal copy and uncluttered layout.

Done when: Wout has selected the visual direction and the actual DMG and app flows match it. The existing large-backdrop viewing direction remains the product reference.

### 02.5 Align CI/CD with T3 Code and finish Mac signing

Updated by Wout on 29 September 2026: adopt T3 Code's automatic nightlies and manual promotion of the latest published nightly's exact commit to Stable. This supersedes the earlier manual-only and stable-draft policies. This section is work for the implementing agent; the comparison did not change the release workflow.

Reference inspected: `pingdotgg/t3code` at `d2c9281b8112dc3b2991642c4bdb985e4b08b9bb`, especially `.github/workflows/release.yml`, `.github/workflows/release-desktop.yml`, `.github/workflows/ci.yml`, `.github/scripts/check-nightly-release.cjs` and `scripts/resolve-nightly-release.ts`. Recheck upstream before implementation and record any deliberate differences. Copy the applicable behavior, not T3's monorepo, hosted-service deployments or runner infrastructure.

| Area                  | T3 Code reference                                                                                     | Required Mr. Streamer change                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Automatic nightlies   | Checks every 30 minutes, requires new commits and at least six hours since the last published nightly | Replace the simple six-hour cron with this eligibility check; keep manual nightly dispatch                                        |
| Stable release source | Manual Stable rebuilds the exact commit of the latest published nightly                               | Resolve the nightly tag to its commit, verify default-branch ancestry and carry that immutable SHA through the entire run         |
| Publication           | Publish only after all required checks and packages succeed                                           | Nightly becomes a prerelease; a manually requested Stable becomes the latest stable release. Stable no longer defaults to a draft |
| Shared build          | Build the platform-independent JavaScript once and distribute it to packaging jobs                    | Reuse one versioned bundle for Mac, Windows and Linux; retain platform-specific FFmpeg builds, signing and installed-app checks   |
| Version bookkeeping   | Nightlies preview a future stable version; finalization records the released stable version           | Replace the automatic next-minor bump with a compatible rule and document overrides, retries and ordering                         |
| Branch testing        | A separate maintainer preview path stays out of normal update feeds                                   | Keep or adapt the existing artifact-only release dry run; no third user-facing channel is required                                |

- [ ] Compare current Mr. Streamer workflows against the reference above. Keep ordinary PR/main CI and release verification consistent, with required checks on the exact source being shipped.
- [ ] Resolve the release source before checks or builds. Manual Stable selects the most recently published valid nightly, ignoring drafts and unrelated prereleases, and derives its default version from that nightly. A version override must not change the selected source commit. Resolve annotated tags correctly and reject missing nightlies or commits outside the default branch.
- [ ] Pin every checkout, check, bundle, installer, release note and release target to that resolved SHA. Advancing `main` during a run must not change its contents. A stable promotion rebuilds the same source with a stable version; it does not reuse nightly-labelled binaries.
- [ ] Check nightly eligibility every 30 minutes. Require at least six hours since the previous published nightly and new commits descended from it. Evaluate this after acquiring the nightly concurrency lock. Manual nightly dispatch may bypass the interval. Handle the first nightly, unchanged history and divergent history explicitly.
- [ ] Serialize publications without cancelling active releases or silently dropping requested Stable runs. Keep nightly and stable queues independent, and check duplicate tags and release ordering before publication.
- [ ] Build the shared JavaScript bundle once with the resolved release version. Package it on the existing Mac arm64, Windows x64 and Linux x64 runners. Retain required tests, FFmpeg caching/builds and installed-app checks; do not add T3's other architectures or infrastructure without a project need.
- [ ] Publish only after every required check, platform build, signing check and artifact validation succeeds. Attach installers, updater metadata, checksums, dependency source archives and notes tied to the resolved commit. Mark nightlies as prereleases without replacing latest stable; mark promoted Stable as latest. Define safe recovery from a failed or repeated publication.
- [ ] Align version bookkeeping with T3's approach. Record the released stable version only after successful publication, derive the next nightly target without requiring an automatic minor bump, and prevent duplicate or backwards versions when finalization is delayed. Document any repository permissions needed for finalization and its recovery path.
- [ ] Retain a maintainer dry run that exercises packaging and signing without publishing to either update channel. Keep branch artifacts out of normal updater feeds. Limit signing credentials to trusted runs; fork PR checks must not require release secrets.
- [ ] Add focused behavioral tests for source selection, version ordering and publication eligibility: first nightly, six-hour boundary, unchanged/divergent history, drafts and unrelated prereleases, manual Stable promotion while `main` advances, missing nightly, and duplicate versions. Verify failure gates and cancellation/queue behavior in a dry run.
- [ ] Update `docs/maintainers/releasing.md` and related maintainer guidance for the final workflow, including manual Stable promotion, nightly timing, overrides, dry runs, publication recovery and first-release setup. Document deliberate differences from T3 Code.
- [ ] Preserve Developer ID signing, hardened runtime, notarization and ticket stapling using Wout's paid membership. Walk Wout through any remaining account, local Mac and GitHub Actions setup; guide only the steps he must perform himself. Missing required signing inputs or failed notarization must fail a release build.
- [ ] Include the updater ZIP alongside the Mac DMG. Keep Windows unsigned with an isolated path to enable signing later. Preserve Linux AppImage and DEB delivery.
- [ ] Verify the redesigned downloaded DMG, Windows installer and Linux packages on target systems. Record the exact build, source SHA and results, including installation and launch without development tools or a UI server.

Done when: automatic nightlies and manual Stable promotion follow the agreed source and publication policy; all release artifacts come from one verified revision; dry runs cannot reach user update feeds; Mac signing/notarization and the supported packages pass verification. Keep the repository private during the slice. Wout controls the first public launch; do not trigger releases or change visibility just to complete this checklist.

### 02.6 Deliver user-initiated updates and channels

- [ ] Add one Stable/Nightly selector to the app. A downloaded build establishes its initial channel; persist explicit user changes. Show the installed version and selected channel.
- [ ] Stable users receive stable releases only. Nightly users can receive newer nightly and stable releases. Keep their chosen channel when installing a stable version unless they explicitly change it.
- [ ] Implement a user-started check/download flow with progress and useful failure/retry states. Require a separate restart confirmation after the update is ready. Playback continues until the user chooses to restart.
- [ ] Verify that normal in-app upgrades and manual installation of a newer package preserve credentials, preferences and watch history across all supported package types.
- [ ] Test updates during private development with controlled artifacts and an update feed. Ship no repository access token in the app. Prepare the final public GitHub destination for use once the project becomes public.

Done when: two real installed versions can update through the intended feed on each platform, channel filtering is correct, and both in-app and downloaded-package upgrades preserve data. Fresh-install tests alone are insufficient.

### 02.7 Implement both routes back to Stable

- [ ] **Switch to Stable:** retain the installed version and data; receive a newer stable release when available. Explain when the installed nightly is ahead of stable. Do not silently downgrade it.
- [ ] **Start fresh on Stable:** explicitly confirm deletion of local subscription credentials, preferences, watch history and catalogue cache, then install the latest stable even if older. Explain that the user must reconnect their subscription. This affects only this device's Mr. Streamer data, not the provider account or other devices.
- [ ] Download and verify the stable payload before starting a reset. Cancelling or failing during download/preparation must preserve the current app and data.
- [ ] Prove the installer/reset ordering on each platform. A confirmed completed reset starts Stable with clean local state; test interruption and a usable recovery path rather than assuming binary replacement and data deletion are atomic.

Done when: both routes work against a nightly newer than the available stable build; normal switching preserves data; only the explicitly confirmed clean path removes it; preparation failures do not reset anything.

### 02.8 Prepare user docs and the contribution policy

- [ ] Make the public README the user entry point: what the app does, supported systems, where to download it, installation, connecting a subscription, everyday use and where to report bugs.
- [ ] Put user instructions in a clearly separate user-documentation area. Explain Stable/Nightly channels, user-initiated updates, manual replacement, clean-stable reset, known playback limits and the current unsigned Windows installation experience.
- [ ] Keep architecture, local development, test fixtures, signing setup, release operations, agent handoffs and slice task lists in maintainer/agent documentation. Link that area from a development section rather than placing internal instructions in the main user journey. Update cross-links when moving existing material.
- [ ] Add a clearly linked contribution policy, such as CONTRIBUTING.md, stating that during active build-out only small bug-fix contributions are accepted. State that feature additions, broad refactors and other large contributions are not currently accepted. Apply the same rule in any contribution instructions or PR template so contributors see it before investing work.
- [ ] Review documentation intended to ship publicly for private provider examples, credentials and environment-specific access details. Use safe examples and make user instructions work without access to the maintainer's infrastructure or planning tools.

Done when: a new user can find install/use/update guidance without reading agent tasks; a maintainer can find build/test/release instructions; the temporary small-bug-fix-only contribution policy is explicit and easy to find. Check documentation against the actual packaged workflows.

### 02.9 Record acceptance and the public-release handoff

- [ ] Run the completed viewing, catalogue refresh, install and upgrade workflows on Mac, Windows and Linux. Record build/version, OS, architecture, package type, results and material limitations.
- [ ] Exercise an unavailable stream, connection interruption, failed refresh, cancelled/failed update and interrupted installation. Verify recovery without unrequested data deletion.
- [ ] Verify release-channel routing, manual replacement, data preservation, clean-stable reset and the actual Mac download/install/launch experience.
- [ ] Record remaining setup or device gaps honestly. A Linux headless run does not establish Mac or Windows acceptance, and mock streams do not establish compatibility with the selected subscription.
- [ ] Prepare Wout's public-release handoff: first good release candidate, release notes, artifact locations, user documentation, the contribution policy and the public feed verification to perform after visibility changes.

Done when: acceptance evidence supports closing slice 02 and the first public release can be reviewed. Wout makes the repository public and publishes that release after the slice; those actions are not automatic completion steps for this agent.

## Scope boundaries

Additional provider types, generic M3U/XMLTV source management, multiple subscriptions, full EPG, movie/series browsing, mobile/TV and external metadata enrichment remain later work. Windows signing, app stores, hosted UI and additional desktop architectures remain outside this slice. Scheduled nightly publishing and manual Stable promotion are now required under 02.5. T3's tag-triggered Stable shortcut, hosted deployments and third user-facing channel are not required.

Do not promise every possible codec or feed. Establish a representative sample set, demonstrate improvement on the supported platforms and record remaining limits. Engine choice and platform installation details are investigations; the agreed product behaviour above is settled.

## References

- [Idea and roadmap](https://r3b736io0gst.postplan.dev)
- [Slice 01 scope and current acceptance](https://qj40mqi2sr5l.postplan.dev)
- [Mr-Streamer-OSS organization](https://github.com/Mr-Streamer-OSS)
- [Apple Developer ID distribution](https://developer.apple.com/developer-id/)
- [electron-builder update targets and metadata](https://www.electron.build/v26/docs/features/auto-update/)
- [libmpv embedding](https://mpv.io/manual/stable/#embedding-into-other-programs-libmpv)
