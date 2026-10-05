# Microsoft Store

> For maintainers. How a stable release reaches the Store, the one-time setup, and what to do when a submission fails. [Releasing](releasing.md#microsoft-store-package) covers how the package is built, numbered and checked, and [licences](licences.md#microsoft-store) the source offer the listing carries.

The Store gets a Windows x64 MSIX of each stable release, beside the direct-download installer. The listing is public: anyone installs it from `https://apps.microsoft.com/detail/9N45GG76ZP4T`, and an update reaches every Store user once Microsoft certifies it. The Store installs and updates the app, and signs what it delivers.

After a stable release is published, the release run sends its package to Partner Center through Microsoft's [Store submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services). That is off until the owner [sets it up](#setting-up) and turns it on. Until then, and whenever the automation can't go on, a package is [submitted by hand](#submitting-by-hand). Credentials, identity documents and anyone's addresses never go into the repository, logs or published evidence.

## Package identity

From Partner Center's Product identity page. These values are public: every package carries them, `apps/desktop/electron-builder.yml` uses them exactly, and none may change.

| Value                                   | Mr. Streamer                              |
| --------------------------------------- | ----------------------------------------- |
| Package/Identity/Name                   | `MrStreamerOSS.Mr.Streamer`               |
| Package/Identity/Publisher              | `CN=A132E842-C4C9-40BF-83C4-D304E7952C2D` |
| Package/Properties/PublisherDisplayName | `Mr Streamer OSS`                         |
| Package family name                     | `MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr` |
| Store ID                                | `9N45GG76ZP4T`                            |

The publisher display name has no period on purpose: Partner Center doesn't allow one there. The Store ID is also what the submission API calls the application ID. `scripts/store-release.ts` holds the identity the automation insists on.

## How a release reaches the Store

1. The stable release run builds the MSIX, tests it installed, and keeps it as the artifact `msix-<version>` with a record of its release, commit and SHA-256 ([releasing](releasing.md#microsoft-store-package)).
2. Once the release is published and the package passed every check, the run's **Microsoft Store** job starts, from `.github/workflows/microsoft-store.yml`. Only a stable release started from `main` gets there: never a nightly, a dry run, a push or a tag. It's a job of the release run because GitHub starts no workflow for a release the workflow's own token created.
3. `scripts/store-release.ts` checks, before anything signs in:
   - the release is published, neither a draft nor a pre-release, and its tag points at the commit the run built, which `main` contains
   - the package is that run's own artifact, and its checksum is the one the build job reported and the one in its record
   - the package's manifest carries the identity above, x64, and the release's [Store version](releasing.md#store-versions)
4. `scripts/store-submission.ts` then signs in and:
   - reads the published submission and any submission in progress
   - creates a submission, which is Microsoft's copy of the published one
   - changes two things in it. The package: the new one is added and the copied ones are marked for removal, since the Store gives the newest to everyone they served. And "What's new": the titles of the release's changes, without authors and links. The description, screenshots, trailers, price, markets and every other field go back as they came.
   - uploads the package under a name that carries the release's commit and the file's checksum, such as `Mr-Streamer-0.0.5-win-x64.5f3a9c0d1e2f.0a1b2c3d4e5f6071.msix`
   - commits the submission and waits, ten minutes at most, until Microsoft has taken or refused the upload
5. Microsoft certifies the submission, which can take up to three business days, and the listing publishes it as soon as it passes. The job doesn't wait for that: [status](#checking-and-repeating) reads how it ended.

The release is out before the job starts, and neither the update feed nor the version commit waits for it. A failed submission shows on the release's run and changes nothing about the release.

### What a run reports

Each on its own line, in the log and the run's summary: the GitHub release, its commit, the Store package version and file name, the submission ID and Microsoft's status. A committed submission isn't a published one, so the last line says which it is.

| Microsoft's status                                                                               | What it means                             | The run          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------- |
| `Published`                                                                                      | Live in the Store                         | Passes           |
| `CommitStarted`, `PreProcessing`, `Certification`, `Release`, `Publishing`, `PendingPublication` | Microsoft is checking or publishing it    | Passes, not live |
| `PendingCommit`                                                                                  | A draft that was never committed          | Fails            |
| `CommitFailed`, `PreProcessingFailed`, `CertificationFailed`, `ReleaseFailed`, `PublishFailed`   | Microsoft refused it                      | Fails            |
| `Canceled`, or a status this list doesn't name                                                   | Stopped, or unknown and treated as failed | Fails            |

### What it never does

- It never sets who sees the app or when it is published. The published submission must be `Public` and publish as soon as it is certified, which the API calls `Immediate`. Otherwise the run stops before it creates anything.
- It never deletes a submission, and never changes one that was committed.
- It never starts a second submission. The Store takes one at a time: a submission in progress that doesn't hold this release's package stops the run, whoever made it.
- It never sends a package the Store's own doesn't sort before.
- It repeats only requests that change nothing by being repeated. When creating or committing gets no clear answer, it reads what happened instead of asking twice.
- It prints nothing of the key, a token or an upload address, and of Microsoft's answers only what the script knows the shape of.

Don't edit a draft the automation made in Partner Center. Once someone has, Microsoft's API can no longer change or commit that submission.

## Checking and repeating

Run the **Microsoft Store** workflow on `main`, with one of three actions:

- **preflight** signs in and lists what the account holds: the application, the published submission with its audience and publishing mode, its packages, listings and trailers, and any submission in progress. With a version it also checks that release's package and says what a submission would do. It reads only, and works before submissions are turned on.
- **status**, with a version, says where that release stands in the Store. Run it a few days after a release to see whether certification passed. It finds a package uploaded by hand too, by its version, and says so. It reads only.
- **submit**, with a version, sends a published stable release's package when the release's own run couldn't. It takes the package from the newest stable release run that still holds `msix-<version>`, and follows the same checks and rules. Run again for a release the Store already has, it reports where that submission stands and sends nothing.

Every Store job, a release's or one started by hand, waits its turn in one queue, so no two read or change the Store at once.

## When a submission fails

The release is out either way. The run's error names the case.

- **Submissions are off:** a notice on the release's run, and no failure. [Submit by hand](#submitting-by-hand) or [set the automation up](#setting-up).
- **The MSIX job failed:** the Store job was skipped. Re-run the failed jobs. When the package passes, the Store job follows in the same run. A package that failed a check is kept as `msix-failed-<version>` and is never submitted.
- **Another submission is in progress:** let it finish, or delete it in Partner Center if nobody needs it, then run **submit**.
- **A submission appeared and nothing shows whether this run made it:** the request to create one got no answer. Open that submission in Partner Center. When it is an untouched copy of the published one that nobody is working on, delete it there, then run **submit**.
- **A submission is left as an untouched copy:** Microsoft created it and then refused the package's entry. Delete it in Partner Center, then run **submit**.
- **A draft holds the package but wasn't uploaded or committed:** run **submit**. It finds the draft by the package's name, uploads again and commits it.
- **Microsoft refused it** (`CommitFailed`, `CertificationFailed` and the like): the run prints Microsoft's errors, and Partner Center holds the certification report. Nothing of that release is live. A fault in the package needs a fixed stable release: delete the refused submission in Partner Center first, since the API creates a new one only when none is in progress. A fault in the listing or the notes for certification is fixed in Partner Center, where the submission is then sent again by hand.
- **The listing isn't Public and Immediate:** someone changed the audience or the publishing hold. Decide which is meant. The automation only updates a public listing that publishes when certified.
- **The sign-in is refused:** the key ended or was replaced. [Renew it](#renewing-the-key).
- **No run holds the package any more:** release runs keep it for 90 days. A later stable release brings a new package.

## Submitting by hand

1. Download the artifact `msix-<version>` from the stable release's run. Its `.msix.json` names the package version, the commit and the SHA-256.
2. In Partner Center, start a new submission of Mr. Streamer. It copies the previous one's settings.
3. Under Packages, upload the `.msix`.
4. Check the [settings below](#settings-every-submission-keeps), update "What's new" in the listing, and submit for certification. Certification can take up to three business days.
5. The listing publishes it as soon as it passes.

While a submission made by hand is in progress, the automation refuses to start another. **status** follows it by the package's version.

## Setting up

`scripts/setup-microsoft-store.sh` walks through it, resumes where it stopped, and keeps its progress in the gitignored `.local/`. It needs `gh` signed in with admin access to the repository. Each stage asks before it changes anything.

1. **tenant:** Partner Center needs a Microsoft Entra tenant linked to the account, under Account settings > Tenants. The page links an existing directory or creates one.
2. **application:** an application of that tenant, added under Account settings > User management > Microsoft Entra applications with the **Manager** role. Microsoft's submission API takes no lesser role, and a Manager can change every product and user of the account, so its key is as sensitive as the owner's own sign-in.
3. **environment:** the GitHub environment `microsoft-store`, which only `main` may use, with the two IDs as variables.
4. **key:** a key of the application, stored as the environment's secret. The wizard reads it hidden, hands it to GitHub through `gh`'s standard input and keeps no copy.
5. **check:** a **preflight** run, which signs in and reads the account without sending anything.
6. **activate:** the repository variable that turns submissions on.

| Setting                       | Where                                         | What it is                                                         |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `STORE_TENANT_ID`             | Variable of the `microsoft-store` environment | The tenant's ID. Not secret.                                       |
| `STORE_CLIENT_ID`             | Variable of the `microsoft-store` environment | The application's ID. Not secret.                                  |
| `STORE_CLIENT_SECRET`         | Secret of the `microsoft-store` environment   | The application's key                                              |
| `STORE_CLIENT_SECRET_EXPIRES` | Variable of the `microsoft-store` environment | The day the key ends, as `YYYY-MM-DD`                              |
| `STORE_AUTOMATION_ENABLED`    | Repository variable                           | `true` lets a run submit. Anything else, and nothing is ever sent. |

The API needs no seller ID.

The environment must exist for `main` alone before any job names it: GitHub creates a missing environment, open to every branch, for the first job that does. So the workflow's first job reads the setup through GitHub's API and stops when the environment is missing or allows more than `main`. Only then does the Store job start. That job runs `main`'s scripts with node alone, installs no packages, never checks out the release's commit, and gives the key to its last step only.

### Renewing the key

The key ends on the day Partner Center shows beside it. The Store job warns from 30 days before the recorded day, and a key that has ended fails the sign-in.

1. Run `scripts/setup-microsoft-store.sh key`: add a new key in Partner Center, and the wizard stores it and its end day.
2. Run `scripts/setup-microsoft-store.sh check` to see the new key sign in.
3. Only then select **Remove** beside the old key in Partner Center.

### Revoking

Remove the key on the application's page in Partner Center, or delete the application under User management. Either ends its access at once. Do it right away when the key may have leaked, then look through the app's submissions in Partner Center for one nobody here made. Deleting the GitHub secret alone revokes nothing.

### Turning it off

```sh
gh variable set STORE_AUTOMATION_ENABLED --body false
```

From then on a stable release says that submissions are off and sends nothing. The read-only actions keep working.

## Settings every submission keeps

A submission copies the one before it, by hand or through the API, so these stay as they are unless someone changes them in Partner Center.

**Pricing and availability.** Every market. Public audience. Free, with no trial or sale, and the organizational licensing defaults.

**Properties.** Category Entertainment. "Yes, my product uses personal information", with `https://mrstreamer.app/privacy`. Website `https://mrstreamer.app`, support `hello@mrstreamer.app`. Untick "designed to run in an immersive (not 2D) view on Windows Mixed Reality" for PC and HoloLens: ticked, it declares a headset app and Partner Center then demands headset hardware. Windows backups to OneDrive off, since the data stays on the PC and a password sealed with the Windows account couldn't be opened elsewhere. No accessibility claim until someone tests it. No system requirements.

**Age rating.** The IARC questionnaire for "All Other App Types", answered honestly. Online Content is Yes, because the app plays whatever the user's provider sends, which gives 18+ everywhere (ESRB Adults Only). Store policy 11.11.2 asks for an accurate rating.

**Listing.** English (United States).

- The description opens with what the app needs, as policy 10.2.4 asks: it supplies no channels, playlists or subscriptions, and the user connects their own provider.
- Screenshots and artwork come from the fake provider with made-up titles, as for the README ([development](../contributing/development.md#artwork)), and stay at a PEGI 12 level (policy 11.1) whatever the app's rating.
- Search terms name the formats it reads, never providers or channels.
- Copyright "Copyright © 2026 Wout Stiens", as in the app and the package.
- **Additional license terms** carry the GPL-3.0 source offer ([licences](licences.md#microsoft-store)).

**Submission options.** No publishing hold: the submission is published as soon as it passes certification. The `runFullTrust` capability needs a justification: Mr. Streamer is an Electron app, which runs as a full-trust Win32 process like every Electron app packaged as MSIX. It starts its bundled ffmpeg and ffprobe as child processes and serves playback through a local proxy on 127.0.0.1. It installs no drivers or services, doesn't start with Windows and writes only to its own data folder.

**Notes for certification**, under Supplemental info > Additional Testing Information. The Description field won't save a link and the Credentials table refuses one too, so the notes say how to find the reviewers' playlist: open the public repository Mr-Streamer-OSS/certification-playlist on GitHub, open `reviewer.m3u`, choose Raw and copy the address. Then connect with **Use an M3U link** and no login. The notes also say that the demo is live TV only, without a guide, that Movies and Series need a provider that offers them, that titles and channels for adults stay hidden until Settings > General > For adults, and that the app asks before sending a login over http. Never give Microsoft a real subscription.

## The reviewers' playlist

[Mr-Streamer-OSS/certification-playlist](https://github.com/Mr-Streamer-OSS/certification-playlist) lists five channels that broadcasters stream free on their own watch-live pages: Al Jazeera English, DW English, DW Español, DW Arabic and ABC News Australia. Check what reviewers will see against it:

```
https://raw.githubusercontent.com/Mr-Streamer-OSS/certification-playlist/main/reviewer.m3u
```

It holds only broadcasters' own official streams that are free worldwide, on their own domains or CDNs, each with its official page cited. No aggregators, restreams, redirectors or geo-blocked streams, and logos only from the broadcaster's own domain. Its README links only, claims no affiliation, leaves the rights with the broadcasters and gives `hello@mrstreamer.app` for removal requests. Wout approves any change to its channels.
