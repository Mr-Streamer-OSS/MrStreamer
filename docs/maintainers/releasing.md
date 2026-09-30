# Releasing

> For maintainers. Using Mr. Streamer? See [docs/user](../user/).

Releases come from `.github/workflows/release.yml`. The app finds them through its update check, which reads published GitHub releases; see [architecture](architecture.md#updates).

## What the workflow does

- Triggers:
  - a scheduled nightly check every 30 minutes
  - manual `workflow_dispatch` with `channel=nightly`, which builds `main` right away
  - manual `workflow_dispatch` with `channel=stable`, the only way to ship stable
  - the **release dry run** label on a pull request
- Manual runs must select `main`; the plan refuses any other branch.
- The plan job (`scripts/release-plan.ts`) resolves the commit, version and tag before anything builds. Every later job checks out that commit, so merges that land during a run never reach its build.
- On that commit, in parallel:
  - the [CI](testing.md#ci) Check and Test jobs
  - `bundle` builds the JavaScript once, with the release version, and hands it to every platform as the `js-bundle` artifact
  - `package` builds each platform on its own runner, from the bundle:
    - the bundled ffmpeg, cached until `apps/desktop/scripts/build-ffmpeg.sh` changes
    - macOS arm64: the DMG, and the ZIP that in-app updates install. Signed with the Developer ID, notarized and stapled (`apps/desktop/scripts/notarize-dmg.ts`), then checked for signature, team, hardened runtime, Gatekeeper and both tickets. Missing secrets or a failed notarization fail the run.
    - Windows x64: the NSIS installer, unsigned; see [Windows signing](#windows-signing)
    - Linux x64: the AppImage and deb
    - every `latest*.yml` must name the release version
    - the [packaged-app test](testing.md#packaged-app) runs on the installed DMG, setup, deb and AppImage
- Publishes only when every check and platform succeeded:
  - checks that each platform's installers and update metadata are present
  - attaches them with the FFmpeg and x264 sources the GPL requires, `SHA256SUMS.txt`, and the [notes](#release-notes)
  - checks again that the tag is unused and the version sorts after every release it competes with, since the other queue may have published meanwhile
  - uploads into a draft, which the app can't see, then publishes it; publishing creates the tag on the planned commit
- Nightlies are pre-releases and never marked latest. Stable releases are marked latest.
- Runs never cancel each other. Nightlies wait in one queue, stable releases in another and each pull request's dry runs in a third, so a nightly never blocks a stable release and a requested stable release is never dropped.

## Versions

- Stable: `0.0.1`
- Nightly: `0.0.2-nightly.20261002.14`, the stable version it previews, the UTC date and the workflow run number

`package.json` on `main` holds the newest stable release, `0.0.0` before the first. A nightly previews the next patch. It counts from the newest stable release instead when `main` hasn't recorded that one yet, so a nightly always sorts after every published release. It sorts before the stable release it previews, which is how nightly users are offered that release.

## Nightly builds

- A scheduled check builds when the last published nightly is at least six hours old and `main` has commits that descend from it. The check runs once the run's turn in the queue comes, so it sees any nightly published ahead of it.
  - No nightly yet: builds.
  - Nothing new since the last nightly, or `main` older than it: skipped.
  - `main` no longer contains the last nightly, after its history was rewritten: skipped with a warning. Start a nightly by hand to continue from `main`.
- Drafts and pre-releases without a nightly version don't count as the last nightly.
- A nightly started by hand skips both conditions.
- The version commit after a stable release counts as new, so a nightly follows each stable release.

## Stable releases

1. Test the latest nightly: install it, update an existing install to it, and play a few channels.
2. Run the Release workflow on `main` with channel **stable**. Leave the version empty to release the version the nightly previewed (`0.0.2-nightly.*` ships as `0.0.2`), or enter one that sorts after it and every stable release, such as `0.1.0`.
3. The run rebuilds the nightly's exact commit with the stable version; the nightly's files carry the nightly version, so they're never reused. Merges to `main` since the nightly don't reach the build.
4. It publishes the release as latest. Stable users are offered it from then on.
5. The finalize job commits `chore(release): prepare vX` to `main`, so `package.json` records the release and later nightlies preview the patch after it.

The plan refuses a stable release when no nightly is published, when `main` doesn't contain the nightly's commit, or when the version is already released or would sort before the nightly.

## Release notes

`release-plan.ts notes` lists every pull request merged between the previous release of the same channel and the commit the run builds, each once, oldest first:

- Stable: from the previous stable release to the promoted nightly's commit, covering every nightly in between. Pull requests merged to `main` after that commit are left out.
- Nightly: from the previous nightly to its own commit.
- A channel's first release lists everything up to its commit.

Commits pushed without a pull request, such as the version commit, aren't listed.

## Dry runs

Add the label **release dry run** to a pull request from a branch of this repository. The run builds, signs, notarizes and tests the pull request's head commit like a nightly, keeps the files as workflow artifacts for 14 days and publishes nothing, so no update channel can offer the build. It takes the label off at once; add it again to test a later commit. The plan also logs what a scheduled nightly and a stable release would do on `main` at that moment.

Forks get no signing secrets, so their pull requests can't run it.

## Recovery

- **A check or platform failed:** nothing was published. Re-run the failed jobs to retry the same commit and version, or fix it on `main` and let the next nightly pick it up. For stable, promote a nightly that has the fix.
- **Publishing failed:** re-run the failed jobs. A broken attempt leaves at most a draft, which the next attempt deletes first.
- **The version was taken meanwhile:** publishing refuses. The next nightly plans a new version; start a stable release again, with another version if needed.
- **Finalize failed:** re-run it. It only moves `package.json` forward, so running it late or twice is harmless, and until it succeeds nightlies count from the published stable release.
- **A bad release is out:** publish a fixed one. Deleting a release stops new offers but doesn't downgrade anyone who installed it.

## Permissions

- The publish job creates releases with the workflow token (`contents: write`) and reads the pull requests behind each commit for the notes (`pull-requests: read`).
- The finalize job pushes to `main` with the same token (`contents: write`). `main` has no branch protection or rulesets. If one is added, let GitHub Actions bypass it or give finalize a GitHub App token, or the push is refused.
- Pushes by the workflow token start no workflows, so the version commit doesn't run CI.
- The plan job removes the dry-run label (`pull-requests: write`).
- Only the macOS packaging step reads the signing secrets; see [signing](signing.md). CI needs none.

## First release

1. Merge the workflow to `main`: GitHub runs manual and scheduled workflows from the default branch's copy. The next scheduled check publishes `0.0.1-nightly.<date>.<run>`; start a nightly by hand to have it sooner.
2. Open `https://api.github.com/repos/Mr-Streamer-OSS/MrStreamer/releases` without signing in: the nightly, with its `latest*.yml` assets, must be listed.
3. Install the nightly on each system and check that the app offers the next one once it's out.
4. Start a stable release to publish `0.0.1`. On Stable, confirm it's offered and nightlies are not.

## Windows signing

Windows installers are unsigned for now, and SmartScreen warns on first run. Signing belongs in the "Build for Windows" step, with its own secrets and never the Mac certificate; electron-builder signs when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are set. Once signed, set `win.signtoolOptions.publisherName` in `electron-builder.yml` so updates must carry the same publisher.

## Testing updates against another feed

The app reads releases from `https://api.github.com`. To try an update flow without publishing, serve a folder of releases through any server that answers `/repos/Mr-Streamer-OSS/MrStreamer/releases` and `/releases/latest` like GitHub (tag, draft and pre-release flags, and assets with download URLs; 404 for the latest release before the first stable one), and start the app with `MR_STREAMER_UPDATE_FEED` pointing at it.
