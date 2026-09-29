# Releasing

Releases come from `.github/workflows/release.yml` on `main`. Users receive them through the app's update check, which reads published GitHub releases; see [architecture](architecture.md#updates).

## Versions

- **Stable:** `0.2.0`.
- **Nightly:** `0.3.0-nightly.20261002.14`: the stable version it leads up to, the UTC build date and the workflow run number.

A nightly sorts after the stable release before it and before the one it leads up to. `package.json` on `main` always holds the next stable version; nightlies take theirs from it.

## Nightly

Every six hours the workflow checks whether `main` changed since the last nightly; version bumps from releases don't count. When it did, the run builds and tests everything and publishes a pre-release, which the Nightly channel picks up. Run the workflow by hand with channel **nightly** to build one right away.

## Stable

1. Run the Release workflow on `main` with channel **stable**. Leave the version empty to release the version on `main`, or enter another one that is newer than every stable release.
2. The run creates a **draft**. Download its files and test them: install the DMG, setup and packages, update an existing install, and play a few channels.
3. Publish the draft on GitHub. Stable users see it from then on.
4. The run has already moved `main` to the next minor version in a `chore(release)` commit, so the following nightlies lead up to it.

To drop a draft, delete it; its tag only exists once it's published.

## What a run does

1. **Plan:** `scripts/release-plan.ts` works out the version and tag, and refuses one that exists or doesn't sort after the newest stable release, drafts included.
2. **Checks:** the CI workflow.
3. **Package**, on macOS, Windows and Linux runners, each on its own:
   - builds the bundled ffmpeg, cached until `scripts/build-ffmpeg.sh` changes;
   - builds the installers with the planned version;
   - on macOS, signs with the Developer ID, notarizes and staples the app and the DMG (`scripts/notarize-dmg.ts`), then checks the signature, team, hardened runtime, Gatekeeper and both tickets; missing secrets or a failed notarization fail the run;
   - checks that every `latest*.yml` names the planned version;
   - installs the DMG, setup or deb, plus the AppImage, and runs the [packaged-app test](testing.md#packaged-app) on each.
4. **Release:** attaches the installers, update metadata, the FFmpeg and x264 sources the GPL requires, `SHA256SUMS.txt` and notes listing the changes since the previous release of the same channel. The release records the exact commit it was built from.

A failed platform stops the release; nothing is published half-built.

**Dry run:** add the label **release dry run** to a pull request, and each push builds, signs and tests the same way, keeping the files as workflow artifacts. Remove the label when done: macOS runner minutes are expensive while the repository is private.

## Windows signing

Windows installers are unsigned for now, and SmartScreen warns on first run. Signing belongs in the "Build for Windows" step, with its own secrets and never the Mac certificate; electron-builder signs when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are set. Once signed, set `win.signtoolOptions.publisherName` in `electron-builder.yml` so updates must carry the same publisher.

## Testing updates before the repository is public

The app reads releases from the public GitHub API, which doesn't show a private repository's releases, and the app ships with no token. To test updates while private, serve a folder of releases through any server that answers `/repos/Mr-Streamer-OSS/MrStreamer/releases` like GitHub (tag, draft and pre-release flags, and assets with download URLs) and start the app with `MR_STREAMER_UPDATE_FEED` pointing at it.

## After the repository goes public

1. Open `https://api.github.com/repos/Mr-Streamer-OSS/MrStreamer/releases` without signing in: the published releases, with their `latest*.yml` assets, must be listed.
2. Install the previous release on each system, then update in the app to the current one.
3. On Nightly, confirm the newest nightly is offered; on Stable, that nightlies are not.
