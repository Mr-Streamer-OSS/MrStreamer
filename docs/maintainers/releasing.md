# Releasing

> For maintainers. Using Mr. Streamer? See [docs/user](../user/).

Releases come from `.github/workflows/release.yml` and live on GitHub Releases. The app finds them through the [update feed](#update-feed), a small file the workflow publishes to GitHub Pages after each release; see [architecture](architecture.md#updates).

## What the workflow does

- Triggers:
  - a nightly check on every push to `main`, and every 30 minutes on a schedule. GitHub starts scheduled runs far less often than asked, often hours apart, so the push is what usually finds a nightly due. The version commit a stable release pushes doesn't start one: GitHub starts no runs for pushes made with the workflow's own token.
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
  - checks again that the tag is unused and the version sorts after every release it competes with
  - uploads into a draft, which the app can't see, then publishes it; publishing creates the tag on the planned commit
- Then points the [update feed](#update-feed) at the release. Until then the app doesn't offer it.
- Nightlies are pre-releases and never marked latest. Stable releases are marked latest.
- Runs never cancel each other. Nightlies and stable releases wait in one queue, and each pull request's dry runs in their own, so a requested stable release is never dropped.
- Sharing the queue keeps a nightly from being planned while a stable release builds. Planned then, it would preview the same version from newer code, and once the stable release published, its users would be offered that release and move back to older code. A stable release waits for a nightly that's running, and the other way round.

## Versions

- Stable: `0.0.1`
- Nightly: `0.0.2-nightly.20261002.14`, the stable version it previews, the UTC date and the workflow run number

`package.json` on `main` holds the newest stable release, `0.0.0` before the first. A nightly previews the next patch. It counts from the newest stable release instead when `main` hasn't recorded that one yet, so a nightly always sorts after every published release. It sorts before the stable release it previews, which is how nightly users are offered that release.

## Nightly builds

- A check, after a push to `main` or on the schedule, builds when the last published nightly is at least six hours old and `main` has commits that descend from it. The check runs once the run's turn in the queue comes, so it sees any release published ahead of it.
  - No nightly yet: builds.
  - Nothing new since the last nightly, or `main` older than it: skipped.
  - `main` no longer contains the last nightly, after its history was rewritten: skipped with a warning. Start a nightly by hand to continue from `main`.
- Drafts and pre-releases without a nightly version don't count as the last nightly.
- A nightly started by hand skips both conditions.
- The version commit after a stable release counts as new, so a nightly follows each stable release.

## Stable releases

1. Test the latest nightly: install it, update an existing install to it, and play a few channels.
2. Run the Release workflow on `main` with channel **stable**. Enter the nightly you tested, such as `0.0.2-nightly.20260930.30` or its tag, so a nightly published after your test can't ship untested. Left empty, the run promotes the latest nightly.
3. Leave the version empty to release the version the nightly previewed (`0.0.2-nightly.*` ships as `0.0.2`), or enter one that sorts after it and every stable release, such as `0.1.0`.
4. The run rebuilds the nightly's exact commit with the stable version; the nightly's files carry the nightly version, so they're never reused. Merges to `main` since the nightly don't reach the build.
5. It publishes the release as latest and updates the feed. Stable users are offered it from then on.
6. The finalize job commits `chore(release): prepare vX` to `main`, so `package.json` records the release and later nightlies preview the patch after it.

The plan refuses a stable release when:

- no nightly is published
- the nightly entered is a draft, has no release, or isn't a nightly version
- `main` doesn't contain the nightly's commit
- the nightly came before the newest stable release, so it can hold older code
- the version is already released or would sort before the nightly

Nightlies published after the one you promote sort before the stable release, so their users are offered it too, without those nightlies' changes. The plan warns when that happens. Start a nightly by hand once the release is out to bring them forward.

## Release notes

`release-plan.ts notes` lists every pull request merged between the previous release of the same channel and the commit the run builds, each once, oldest first:

- Stable: from the previous stable release to the promoted nightly's commit, covering every nightly in between. Pull requests merged to `main` after that commit are left out.
- Nightly: from the previous nightly to its own commit.
- A channel's first release lists everything up to its commit.

Commits pushed without a pull request, such as the version commit, aren't listed.

## Update feed

The app looks for updates in `updates.json` at the root of the repository's GitHub Pages site: `https://mr-streamer-oss.github.io/MrStreamer/updates.json`, or the root of a custom domain once one is set. It downloads them from GitHub Releases. `packages/contracts/src/update-feed.ts` defines the format:

```json
{
  "schema": 1,
  "generated": "2026-09-30T13:40:12.000Z",
  "stable": {
    "version": "0.0.2",
    "published": "2026-09-30T13:33:35Z",
    "page": "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.2",
    "files": "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v0.0.2",
    "notes": "**Stable** · built from ...",
    "platforms": ["latest-mac.yml", "latest.yml", "latest-linux.yml"]
  },
  "nightly": {
    "version": "0.0.3-nightly.20261001.32",
    "published": "2026-10-01T09:12:40Z",
    "page": "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.3-nightly.20261001.32",
    "files": "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v0.0.3-nightly.20261001.32",
    "notes": "**Nightly** · built from ...",
    "platforms": ["latest-mac.yml", "latest.yml", "latest-linux.yml"]
  }
}
```

- `stable` is the highest stable release. `nightly` is the highest release of either channel, since Nightly users receive stable releases too. Highest means by version, never by date. Either is `null` when there is none.
- `files` is the folder electron-updater reads the release's `latest*.yml` and installers from. `notes` is the release body, in Markdown.
- A release counts only when it's published, its version and pre-release flag name the same channel, and it carries `latest-mac.yml`, `latest.yml` and `latest-linux.yml`. One missing a platform is incomplete and never enters the feed.

`.github/workflows/update-feed.yml` writes the feed with `release-plan.ts feed` and deploys it, with an empty `.nojekyll`, after every published nightly and stable release. Dry runs publish nothing. Publications wait in a queue of their own and are never cancelled, so each reads the releases after the one before it deployed.

The feed never goes back. When the releases name a lower version than the deployed feed, that channel keeps the deployed release, so a late or stale publication can't take users back. Only a run by hand with **allow-regress** moves a channel down. A publication that can't read the deployed feed or look up the Pages site stops instead of publishing from the releases alone; only a 404 for either counts as nothing deployed yet.

A failed publication shows on the release run's **Update feed** job but doesn't fail the run, since the release is out by then. Fix the cause, then regenerate the feed.

### Regenerating the feed

Run the **Update feed** workflow on `main`. It rebuilds the feed from the releases as they are now, and the run summary names each channel's release. Tick **allow-regress** only to move a channel to a lower version, after deleting a bad release.

### Enabling Pages

Needed once. Until then, every release's **Update feed** job fails at deploying, without failing the release.

1. In the repository's settings, under Pages, set the source to **GitHub Actions**.
2. Run **Update feed** on `main` to publish the first feed.
3. Open the feed's address: it must name the newest releases.

A custom domain set there moves the feed to that domain's root. The workflow looks the address up through the Pages API, so it needs no change.

## Dry runs

Add the label **release dry run** to a pull request from a branch of this repository. The run builds, signs, notarizes and tests the pull request's head commit like a nightly, keeps the files as workflow artifacts for 14 days and publishes nothing, so no update channel can offer the build. It takes the label off at once; add it again to test a later commit. The plan also logs what a scheduled nightly and a stable release would do on `main` at that moment.

Forks get no signing secrets, so their pull requests can't run it.

## Recovery

- **A check or platform failed:** nothing was published. Re-run the failed jobs to retry the same commit and version, or fix it on `main` and let the next nightly pick it up. For stable, promote a nightly that has the fix.
- **Publishing failed:** re-run the failed jobs. A broken attempt leaves at most a draft, which the next attempt deletes first.
- **The version was taken meanwhile:** publishing refuses. The next nightly plans a new version; start a stable release again, with another version if needed.
- **Finalize failed:** re-run it. It only moves `package.json` forward, so running it late or twice is harmless, and until it succeeds nightlies count from the published stable release.
- **The feed wasn't updated:** the release run passed, and its **Update feed** job shows why. Fix that, such as [enabling Pages](#enabling-pages), then [regenerate the feed](#regenerating-the-feed). When the job couldn't reach the deployed feed or the Pages API, regenerating once GitHub answers again is enough.
- **A bad release is out:** publish a fixed one. To stop offering it sooner, delete the release, then regenerate the feed with **allow-regress**. Deleting alone isn't enough: the feed never goes back by itself, so it keeps offering the release, whose files are gone. Neither downgrades anyone who installed it.

## Permissions

- The publish job creates releases with the workflow token (`contents: write`) and reads the pull requests behind each commit for the notes (`pull-requests: read`).
- The finalize job pushes to `main` with the same token (`contents: write`). `main` has no branch protection or rulesets. If one is added, let GitHub Actions bypass it or give finalize a GitHub App token, or the push is refused.
- Pushes by the workflow token start no workflows, so the version commit doesn't run CI.
- The plan job removes the dry-run label (`pull-requests: write`).
- The feed job reads the releases (`contents: read`) and deploys to Pages (`pages: write`, `id-token: write`) through the `github-pages` environment.
- Only the macOS packaging step reads the signing secrets; see [signing](signing.md). The bundle step reads `TMDB_API_KEY`; see [TMDB key](#tmdb-key). CI needs none.

## First release

1. Merge the workflow to `main`: GitHub runs manual and scheduled workflows from the default branch's copy. The merge's own push finds no nightly yet and publishes `0.0.1-nightly.<date>.<run>`; if it doesn't, start a nightly by hand.
2. [Enable Pages](#enabling-pages) and open the feed: its `nightly` must name the nightly.
3. Install the nightly on each system and check that the app offers the next one once it's out.
4. Start a stable release to publish `0.0.1`. On Stable, confirm it's offered and nightlies are not.

## TMDB key

Movies and Series take genres, popularity and streaming services from TMDB. The bundle step passes the repository secret `TMDB_API_KEY`, a TMDB API Read Access Token, to the build as `MR_STREAMER_TMDB_KEY`, which builds it into the main process's bundle. Without the secret, the build succeeds and the app has no key: movies and series show without genres or services until a viewer adds their own in Settings.

The token can be read out of any installer. It only reads TMDB's public data. If it's abused or revoked, regenerate it in the TMDB account's API settings, update the secret, and release; until then, viewers can use their own key.

TMDB's terms ask that the app shows its logo and notice, which Settings > About does, keeps its data no longer than six months, which the app drops after that, and credits JustWatch for streaming services, which About and the Services tab do.

## Windows signing

Windows installers are unsigned for now, and SmartScreen warns on first run. Signing belongs in the "Build for Windows" step, with its own secrets and never the Mac certificate; electron-builder signs when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are set. Once signed, set `win.signtoolOptions.publisherName` in `electron-builder.yml` so updates must carry the same publisher.

## Testing updates against another feed

To try an update flow without publishing, serve a folder over HTTP holding an `updates.json` in the [feed format](#update-feed), and start the app with `MR_STREAMER_UPDATE_FEED=http://127.0.0.1:PORT/updates.json`. Point each release's `files` at a folder holding its `latest*.yml` and installers, on the same server or on GitHub Releases. Copying the deployed feed and editing `version` and `files` is the quickest start.
