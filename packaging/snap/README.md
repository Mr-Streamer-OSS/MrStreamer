# Snap maintainer runbook

Project contact: Wout Stiens (`hello@mrstreamer.app`). `snapcraft.yaml` makes a strict Snap,
`mr-streamer`, from the Linux release deb without changing the app inside it. The
[strict runtime investigation](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=288196796)
chose this route, and the
[packaging card](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=288196902)
holds its verification. Nothing here registers a name, asks the Store for anything, uploads or
publishes: each of those is a maintainer action that needs its own approval.

## What the Snap is

- **The release deb's app, unchanged.** The dump part unpacks `opt/Mr. Streamer` into `app/`,
  keeping Electron, `app.asar`, ffmpeg and ffprobe byte for byte. It leaves out `chrome-sandbox`,
  the deb's AppArmor profile and its updater files (`app-update.yml`, `package-type`). The
  version is the deb's, with a nightly's `~` written back as `-`.
- **Confined, with Chromium's own sandbox on.** `browser-support` with `allow-sandbox: true`
  gives Chromium its user namespaces. Without that connection the app stops at launch (exit 133);
  it is never started with `--no-sandbox`.
- **Passwords in the desktop keyring or nowhere.** Run from `$SNAP`, the app pins Chromium's
  password store: `kwallet6`, `kwallet5` or `kwallet` on KDE, by `KDE_SESSION_VERSION`, and
  `gnome-libsecret` everywhere else. It never enables Chromium's fixed-key fallback. With no
  reachable keyring, saving a login fails and names
  `sudo snap connect mr-streamer:password-manager-service`. The plug's AppArmor rules allow
  KWallet's own D-Bus API, but **KWallet is untested**: only GNOME Keyring has been run.
- **Updates belong to snapd.** The app reports the `snap` distribution: no update checks,
  downloads, installer, channel or update notice. Settings > Updates names
  `sudo snap refresh mr-streamer`.
- **One profile per revision.** The profile stays in `$SNAP_USER_DATA`
  (`~/snap/mr-streamer/<revision>/.config/Mr. Streamer`), copies included. Snapd copies it on
  each refresh, so a revert returns the data as it was. Copies are deliberately not in
  `$SNAP_USER_COMMON`: on start the app deletes download folders its database doesn't name,
  so a reverted database sharing one folder with a newer revision would delete the newer copies.
  The cost: each kept revision holds its own copies (snapd keeps 2 on classic systems by
  default), and `snap remove` keeps a 31-day snapshot of the current revision's data, copies
  and recordings included. `snap/local/snapshots.yaml` excludes the listed Chromium cache folders.
- **Chosen recording folders are shared, safely.** A recording folder the viewer chooses
  outside the profile is the same for every revision. Each recording in it is marked with the
  profile that made it, which includes the revision, and startup only removes stray recordings
  marked with its own, so a revert never deletes a newer revision's recordings there.
- **No import.** The Snap cannot read a deb or AppImage profile, and doesn't try. A viewer adds
  their subscription again. Both installs can run side by side.
- **Media keys.** The `mpris` slot named `chromium` lets Chromium own its MPRIS bus name.

## Sleep and shutdown

- **Keeping awake.** `screen-inhibit-control` allows the `org.gnome.SessionManager`,
  `org.freedesktop.PowerManagement` and `org.freedesktop.ScreenSaver` Inhibit calls Chromium makes
  for its wake locks. In the VM runs, playback made no logind call; only Electron's two delay locks
  at start were denied. Electron has no desktop-portal Inhibit to try instead. A playing receiver
  keeping a real GNOME or KDE session awake is untested.
- **Sleep notices are lost.** Electron hears sleep and wake from logind's `PrepareForSleep` and
  takes logind delay locks. The Snap's AppArmor profile lets it do neither, and `shutdown` would
  allow only the locks. So under the Snap a recording isn't paused before the computer sleeps,
  and waking runs no checks at once: the reminder and recording loops check at most a minute
  apart anyway, which catches up a reminder or schedule that fell due meanwhile.
- **Shutdown still arrives.** SIGTERM stops capture and records the interruption. On the next
  launch, an interrupted recording resumes if its stop time has not passed.

## Build

On Ubuntu 24.04 amd64 with snapd, in a disposable machine (the release workflow's `snap` job
does exactly this on a GitHub runner):

```sh
sudo snap install snapcraft --classic --channel=9.x/stable
build=$(mktemp -d)
cp -r packaging/snap/. "$build"
cp Mr-Streamer-<version>-linux-amd64.deb "$build/mrstreamer.deb"
cd "$build" && sudo snapcraft pack --destructive-mode
sha256sum mr-streamer_*_amd64.snap
```

Snapcraft's output differs from build to build, even from the same deb. Test, record and upload
one artifact by its SHA-256: the release workflow's `snap-<version>` artifact for a release.

## Verify an artifact

```sh
sudo snap install --dangerous ./mr-streamer_<version>_amd64.snap
sudo snap connect mr-streamer:browser-support
sudo snap connect mr-streamer:password-manager-service
snap connections mr-streamer
```

1. Run the packaged-app smoke from a checkout, with an unlocked keyring on the user's session bus
   and a profile the Snap can see (it has its own `/tmp`, and the `home` plug hides dot folders).
   Snap run tracks the app in a scope of the user's systemd: a private `dbus-run-session` bus
   fails with `is not a snap cgroup`. From a desktop session's terminal:

   ```sh
   mkdir -p ~/snap-e2e
   printf ci | gnome-keyring-daemon --replace --unlock --components=secrets -d >/dev/null
   TMPDIR=~/snap-e2e MR_STREAMER_FFMPEG=/snap/mr-streamer/current/app/resources/ffmpeg/ffmpeg \
     xvfb-run -a node apps/desktop/test/e2e/packaged-app.ts /snap/bin/mr-streamer
   ```

   The first line replaces the session's keyring daemon with one whose `login` keyring is
   unlocked: use it only on a throwaway machine. Without a session (over SSH, or in CI), enable
   lingering and run it in the user's manager with `systemd-run --user`, as the release job does.
   It must report `Updates: snap, for a snap build` and pass every check.

2. Disconnect `password-manager-service`, or run without a Secret Service: adding a subscription
   must fail with the `snap connect` command and leave no login in the profile.
3. Install a second artifact over the first, then `sudo snap revert mr-streamer` and
   `sudo snap revert mr-streamer --revision=<newer x revision>`: local installs have no Store
   revision to refresh to. Settings, the login, copies and recordings stay with each revision.
4. `sudo snap remove mr-streamer` keeps a snapshot of the current revision (`snap saved`),
   without the excluded caches; reinstall, then `sudo snap restore <set>` brings it back and
   `sudo snap forget <set>` deletes it. `snap remove --purge` makes none, and deletes no older
   snapshot. Neither removes the keyring's Chromium Safe Storage item.

## Owner actions, none taken

In this order, each with its own approval:

1. **Register the name** `mr-streamer` with the project's Snapcraft account
   (`snapcraft register mr-streamer`). Check first that the name is free; never take over a name
   someone else holds.
2. **Required: a snap declaration for `browser-support` with `allow-sandbox: true`**, asking for
   connection and auto-connection, on the [Snapcraft forum's store-requests
   category](https://forum.snapcraft.io/c/store-requests/19). The reason: Chromium's renderer
   sandbox needs user namespaces, and snapd's base declaration denies this connection. If the
   Store refuses it, this route is a no-go: there is no unsandboxed fallback.
3. **Strongly preferred: auto-connection of `password-manager-service`**, saying plainly that it
   reaches the user's whole keyring, and that the app uses it only for its own Chromium Safe
   Storage key. Without it, every viewer runs the `snap connect` command once.
4. **Optional:** `personal-files` to read an old deb profile, for a later import; the `mpris`
   name. Not `shutdown`: see [Sleep and shutdown](#sleep-and-shutdown).
5. **Upload** the pinned artifact to `edge` (`snapcraft upload --release=edge <file>`), install it
   from the Store on a clean machine, repeat the checks above against Store assertions and
   auto-connections, and only then promote. Publication to `stable` needs a maintainer's approval,
   as every stable release does.

## Store listing

- **Title** `Mr. Streamer`; **summary** and **description** from `snapcraft.yaml`, which say the
  app has no content of its own and keeps passwords in the keyring.
- **Icon** `snap/gui/icon.png`, 512 × 512, from `apps/desktop/build/icon.png`.
- **Category** Entertainment (primary), Photo and video.
- **Links** website, contact, source code and issues, from `snapcraft.yaml`; licence
  GPL-3.0-only.
- **Screenshots**: the Linux listing candidates in `docs/assets/linux-listing/`, with their
  captions and credits (NASA, U.S. National Park Service) from its `manifest.json`. They are
  unedited Openbox captures of a source build; [their limits](../../docs/contributing/linux-listing-capture.md)
  apply. Recapture from the Snap itself before a public listing if the Store asks for it.
