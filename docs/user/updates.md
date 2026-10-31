# Updates and channels

With a direct or Homebrew installation, Mr. Streamer looks for updates a little after it starts and then every four hours. It never downloads or restarts without you: you download an update, and then choose when to restart into it. The [AUR](#installed-through-the-aur), [Snap](#installed-as-a-snap) and [Microsoft Store](#installed-from-the-microsoft-store) manage their updates separately. Your login, preferences, favourites and history stay through every update.

## When an update is available

**Update** appears at the top right, with a dot. It stays quiet while you watch: it fades with the other controls, and nothing covers the picture.

1. Click **Update** to see the new version and what changed.
2. Choose **Download**. It downloads while you keep watching; the top bar shows how far it got, and **Cancel** stops it.
3. When it's ready, the top bar says **Restart to update**. Choose **Restart** when it suits you: playback stops for a moment while Mr. Streamer restarts on the new version. **Later** keeps it ready until you restart.

**Not now** hides the notice for that version. A newer version shows it again, and Settings keeps offering the one you skipped.

On Linux, installing the deb package asks for your password, because installing a package needs administrator rights. The AppImage replaces itself without asking.

## A reminder when Stable is behind

Starting with the 0.0.21 client, direct and Homebrew Stable copies show a centered reminder when at least two published Stable releases are newer than yours. It uses the known previous Stable release, including skipped version numbers; an older feed without that history keeps the quiet update notice. Current, ahead and one-release-behind copies get no prominent reminder. This cannot add reminders to older clients.

The reminder appears at most once per app process launch, while you browse. Full Watch and movie or episode playback defer it until you return; the muted Home preview does not. **Not now** or Escape closes it and returns keyboard focus, leaving the quiet **Update** entry available. Rechecking, reopening the window or finding a newer offer during that launch does not repeat a reminder already shown. The next app launch can remind you again. **Download** starts only when you choose it, and restart still needs your confirmation.

Nightly, Microsoft Store and AUR copies keep their existing update behavior, and Snap copies get none.

## Updates in Settings

Settings (⌘, on macOS, Ctrl , on Windows and Linux) > **Updates** shows your version, where the update stands: when Mr. Streamer checks next, that it's up to date, or the step the update is at, with the same actions as the top bar, and your channel. **Check now** looks straight away. **What's new** lists the changes in the offered version, each linked to its details.

When a check doesn't work, Settings says why in a few words: you're offline, the update server answered with an error, or GitHub is limiting requests from your network and until when. A check Mr. Streamer made on its own fails quietly and tries again later, sooner at first. Either way, an update found earlier stays available to download.

## Install a newer version by hand

**GitHub ›** beside an offered update in Settings opens its release. You can also take an installer from the [download page](https://mrstreamer.app/download) and install it over the old one. Mr. Streamer keeps its data in a folder of its own (see [Troubleshooting](troubleshooting.md#where-your-data-is)), so everything carries over.

## Installed through Homebrew

The maintained Homebrew tap uses the same signed stable DMG for macOS 13 or later on Apple silicon. The [download page](https://mrstreamer.app/download) has the current install command.

You can keep updating in the app. For a Homebrew update, quit Mr. Streamer first, then run `brew upgrade`. This can update other Homebrew packages too. Quit before a reinstall or uninstall as well.

With Homebrew's default upgrade settings, plain `brew upgrade` compares the installed app with the tap and can skip an app that updated itself to a newer version. Stable and Nightly use different version formats, which Homebrew cannot reliably compare, so it normally skips that comparison. Use the app's updater to switch channels.

An explicitly named upgrade, `--greedy` or `brew reinstall` can replace a newer app with the tap's version. Before an intentional replacement, compare Settings > **About** with `brew info --cask mr-streamer-oss/tap/mr-streamer`.

Homebrew replaces the app bundle. Your profile and downloaded copies live outside it, and Homebrew uninstall leaves them in place. If a direct install already occupies the destination, quit it and move only its app bundle aside before installing through Homebrew. Leave the profile and downloads alone.

## Installed through the AUR

On Arch Linux, x86_64, [mrstreamer-bin](https://aur.archlinux.org/packages/mrstreamer-bin) packages the stable release with its bundled player and media tools. With yay installed, run `yay -S mrstreamer-bin`; with paru, run `paru -S mrstreamer-bin`.

Without an AUR helper, install the build tools and fetch the recipe:

```sh
sudo pacman -Syu --needed base-devel git
git clone https://aur.archlinux.org/mrstreamer-bin.git
cd mrstreamer-bin
```

Review `PKGBUILD`, then run `makepkg -si` as your regular user. It packages the prebuilt app and asks for your password to install it. Open **Mr. Streamer** from the application menu, or run `mrstreamer`.

Quit Mr. Streamer before an upgrade, reinstall or uninstall. To update, run `yay -Syu` or `paru -Syu`; these update your other packages too. For a manual update, run `sudo pacman -Syu`, then `git pull --ff-only` in the recipe directory, review the changes and run `makepkg -si` again. See Arch's [AUR guide](https://wiki.archlinux.org/title/Arch_User_Repository#Installing_and_upgrading_packages) for the build steps.

The AUR copy leaves updates to your package manager. It never downloads an app update or replaces its own files. Settings > **Updates** points you to an AUR helper or makepkg, with no Stable or Nightly channel to choose. `pacman -Syu` alone does not fetch AUR updates.

Your login, preferences, favourites, watchlist, playback progress, downloaded copies and saved subtitles stay through an upgrade. A direct AppImage and the AUR copy use the same Linux profile and desktop keyring: quit the AppImage before switching, and leave the profile and downloads in place.

To uninstall, run `sudo pacman -R mrstreamer-bin`. This removes the app and keeps your profile, downloaded copies and keyring credentials. Installing it again reuses them.

## Installed as a Snap

The release workflow attempts to build and test a Snap for each stable release and dry run. A failed Snap job does not block a stable release, so its Snap artifact may be absent. The Snap is not in the Snap Store yet: the Store still has to allow the connection Chromium's sandbox needs. Until then, a Snap build installed by hand (`sudo snap install --dangerous`) never updates on its own: install the next build the same way, and connect it as the [Snap runbook](../../packaging/snap/README.md#verify-an-artifact) says.

Once it's in the Store, snapd updates the Snap, so Mr. Streamer never looks for updates, downloads them or offers a channel. Settings > **Updates** shows your version and how to update it now: quit Mr. Streamer, then run `sudo snap refresh mr-streamer`. Snapd holds its automatic updates back while Mr. Streamer is open, for up to 14 days, then updates it anyway.

Logins use the desktop keyring, with no plain-text fallback. GNOME Keyring has been verified; KDE/KWallet has not yet been verified for this Snap. If the keyring can't be reached, adding a subscription fails and names the command that connects Mr. Streamer to it, which you run once:

```sh
sudo snap connect mr-streamer:password-manager-service
```

Check that your keyring is running and unlocked too: on KDE it has to be KWallet. On a desktop without one, such as a plain Openbox session, start GNOME Keyring first. If a saved subscription says it needs its password again because Mr. Streamer lost that connection, connect it and reopen Mr. Streamer: the saved password comes back.

The Snap keeps its own data with each revision, in `~/snap/mr-streamer/`, including downloaded copies and recordings saved in the default profile folder. Recordings in a chosen folder outside the Snap's data directories, such as `~/Videos`, are shared across revisions and are not in its removal snapshot. The following applies to the Snap's own data:

- **Updates** copy everything to the new version, so your login, preferences, favourites, watchlist, progress, copies, recordings and saved subtitles carry over. Snapd keeps the previous version too, so copies take their space twice until it drops that one; `du -sh ~/snap/mr-streamer/*` shows how much.
- **Going back** with `sudo snap revert mr-streamer` returns the data as it was before the update. What you changed or downloaded after it stays with the newer version while snapd keeps it: `snap list --all mr-streamer` lists the kept versions, and `sudo snap revert mr-streamer --revision=<revision>` returns to one. The next update copies the data you went back to, and the newer version's goes when snapd drops it.
- **Uninstalling** with `sudo snap remove mr-streamer` keeps a snapshot of the current version's data for 31 days, excluding the listed Chromium cache folders. `snap saved` lists it; after installing again, `sudo snap restore <set>` brings it back, and `sudo snap forget <set>` deletes it. `sudo snap remove --purge mr-streamer` makes no snapshot. Neither touches your login in the desktop keyring.

The Snap is separate from the deb, the AppImage and the AUR copy. It can't read their data, and doesn't import it: add your subscription again, and your favourites, history and copies stay with the other install. Both can be installed and open at the same time. Downloaded copies stay in the Snap's own folder. Recordings can go to a folder you choose: the folder picker gives the Snap the folder you pick, also on a USB drive. On a desktop without that picker's portal, a folder under `/media` or `/mnt` also needs `sudo snap connect mr-streamer:removable-media`.

## Installed from the Microsoft Store

The Microsoft Store updates a copy you installed from it, so Mr. Streamer never looks for updates or downloads them, and shows no update notice. Settings > **Updates** shows your version, updated by the Microsoft Store, and **Open Store** opens Mr. Streamer's page there. The Store only carries stable releases, so there's no channel to choose.

Windows lists the Store copy with 1 added to the first number of the version, such as 1.0.4.0 for Mr. Streamer 0.0.4, because the Store doesn't take a 0 there.

The Store and the Start menu call it "Mr. Streamer: IPTV Player"; packages up to 0.0.7 use "Mr. Streamer". It's the same app.

The Store copy and a copy installed from the setup file are separate. Each keeps its own login, preferences, favourites and history, and neither reads or changes the other's. Moving from the setup file to the Store copy starts fresh: you sign in again, and your favourites, history and progress stay with the other copy. Store updates keep its data. Uninstalling it removes its data, as Windows does for every Store app.

## Stable and Nightly

These channels apply to direct downloads and Homebrew. The AUR, the Snap and the Microsoft Store carry stable releases and manage updates separately.

- **Stable** gets tested releases only.
- **Nightly** gets new builds first, up to four a day when there are changes. It never offers a stable release: each stable release is a tested nightly, so the nightlies carry its changes. Nightly builds can have rough edges.

The version you download sets your channel on first launch. After that, only **Channel** under **Updates** in Settings changes it. Installing a stable release while on Nightly keeps you on Nightly, and Mr. Streamer offers the next nightly once one is out. Nightly never offers a version older than yours. The same goes when you switch a stable release to Nightly.

## Going back to Stable

Choose **Stable** as the **Channel** under **Updates** in Settings. Mr. Streamer offers the newest stable release right away, even when it is older than your nightly, and installs it like any other update: your login, preferences, favourites and history stay.

A stable release older than your nightly may not have everything the nightly has. Stable 0.0.2 has no movies and series; how far you got in them stays saved and is back when you return to Nightly or a stable release that has them.
