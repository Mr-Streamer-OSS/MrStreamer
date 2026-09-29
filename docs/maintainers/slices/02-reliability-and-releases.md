# Slice 02: reliable playback and releases

Status: scoped for the next agent. Implementation has not been completed by this handoff.

Outcome: play a broader, verified set of the selected subscription's streams on Mac, Windows and Linux; preserve usable data through refreshes and normal upgrades; prepare nightly or stable releases; update from inside the app or through a downloaded installer.

## Start here

- Read the latest slice 01 changes and acceptance evidence before estimating or changing code. Another agent is finishing that work. Preserve its changes and use its completed build as the baseline.
- Wout will transfer the repository into **Mr-Streamer-OSS** after the latest slice 01 build is ready. The organization already exists. Verify transfer completion and the actual repository name before configuring release destinations, updater URLs or repository-bound credentials.
- Keep the repository private throughout slice 02. Wout intends to make it public for the first good release after this slice. Transfer, visibility changes and public release publication are actions for Wout or require his explicit instruction.
- Repository transfer blocks release-destination setup, not independent playback investigation, library work or design exploration.
- Use the existing modular boundaries. Keep provider access, library state, playback, platform installation/signing and UI responsibilities separate. Reuse work that already satisfies the contract.

## Agreed product decisions

- One desktop app supports Mac, Windows and Linux. It has Stable and Nightly distribution channels with shared local data.
- Releases are cut only when Wout chooses. A manual GitHub workflow prepares either a nightly or stable release. Nightly is a development channel, not a scheduled build.
- The workflow prepares a draft release with checks, platform artifacts and release notes. Wout tests the actual artifacts before publication.
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

### 02.5 Configure manual releases and Mac signing

- [ ] After transfer, configure a manually triggered GitHub workflow that accepts the intended version and channel and records the exact source revision.
- [ ] Define unique version ordering for nightly and stable builds. Prevent an older build or nightly publication from replacing the stable update feed. Verify routing explicitly rather than relying on inferred tag names.
- [ ] Run required checks and build the supported Mac, Windows and Linux artifacts. Assemble release notes, update metadata and integrity information into a draft release. A failed required platform build must not produce a release marked ready.
- [ ] Configure Developer ID signing, hardened runtime, notarization and ticket stapling for Mac releases using Wout's paid membership. Inspect available credentials first; guide Wout only through account steps he must perform himself. Release builds fail when required signing or notarization fails.
- [ ] Include the update payload required by the selected updater alongside the Mac DMG. Keep Windows unsigned for now, with signing configuration isolated for later addition.
- [ ] Verify the redesigned downloaded DMG, Windows installer and Linux packages on the target systems. Test installation and launch without development tools or a UI server.

Done when: the manual workflow can prepare both channels with complete draft artifacts and verified Mac signing/notarization. The repository remains private, and preparation does not automatically publish a public release.

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

Additional provider types, generic M3U/XMLTV source management, multiple subscriptions, full EPG, movie/series browsing, mobile/TV and external metadata enrichment remain later work. Windows signing, app stores, hosted UI, scheduled nightly publishing and additional desktop architectures are not required here.

Do not promise every possible codec or feed. Establish a representative sample set, demonstrate improvement on the supported platforms and record remaining limits. Engine choice and platform installation details are investigations; the agreed product behaviour above is settled.

## References

- [Idea and roadmap](https://r3b736io0gst.postplan.dev)
- [Slice 01 scope and current acceptance](https://qj40mqi2sr5l.postplan.dev)
- [Mr-Streamer-OSS organization](https://github.com/Mr-Streamer-OSS)
- [Apple Developer ID distribution](https://developer.apple.com/developer-id/)
- [electron-builder update targets and metadata](https://www.electron.build/v26/docs/features/auto-update/)
- [libmpv embedding](https://mpv.io/manual/stable/#embedding-into-other-programs-libmpv)
