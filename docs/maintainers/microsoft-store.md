# Microsoft Store

> For maintainers. The Partner Center steps for each Store submission. [Releasing](releasing.md#microsoft-store-package) covers how the package is built, numbered and checked, and [licences](licences.md#microsoft-store) the source offer the listing carries.

The Store gets a Windows x64 MSIX of each stable release, beside the direct-download installer, for a private audience of testers until the public launch. The Store installs and updates it, and signs what it delivers. Submissions are made by hand in Partner Center: `scripts/setup-microsoft-store.sh` walks through them, resumes where it stopped, and keeps its progress in the gitignored `.local/`. Testers' addresses, identity documents and credentials never go into the repository, logs or published evidence.

## Package identity

From Partner Center's Product identity page. These values are public: every package carries them, `apps/desktop/electron-builder.yml` uses them exactly, and none may change.

| Value                                   | Mr. Streamer                              |
| --------------------------------------- | ----------------------------------------- |
| Package/Identity/Name                   | `MrStreamerOSS.Mr.Streamer`               |
| Package/Identity/Publisher              | `CN=A132E842-C4C9-40BF-83C4-D304E7952C2D` |
| Package/Properties/PublisherDisplayName | `Mr Streamer OSS`                         |
| Package family name                     | `MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr` |
| Store ID                                | `9N45GG76ZP4T`                            |

The publisher display name has no period on purpose: Partner Center doesn't allow one there. Testers signed in with an account in the testers' group install from the private link, `https://apps.microsoft.com/detail/restricted/9N45GG76ZP4T`.

## Submitting a stable release

1. Release stable as usual. Download the `msix` artifact from the run; its `.msix.txt` names the package version and the commit.
2. In Partner Center, start a new submission of Mr. Streamer. It copies the previous one's settings.
3. Under Packages, upload the `.msix`.
4. Check the settings below, update "What's new" in the listing, and submit for certification. Certification can take up to three business days.
5. Once certified, the publishing hold leaves the moment to Wout: **Publish now** reaches only the private audience.

## Settings every submission keeps

**Pricing and availability.** Every market. Private audience with the testers' group, and "Make this product public on" unticked: a product first submitted as public can't become private later. Free, with no trial or sale, and the organizational licensing defaults.

**Properties.** Category Entertainment. "Yes, my product uses personal information", with `https://mrstreamer.app/privacy`. Website `https://mrstreamer.app`, support `hello@mrstreamer.app`. Untick "designed to run in an immersive (not 2D) view on Windows Mixed Reality" for PC and HoloLens: ticked, it declares a headset app and Partner Center then demands headset hardware. Windows backups to OneDrive off, since the data stays on the PC and a password sealed with the Windows account couldn't be opened elsewhere. No accessibility claim until someone tests it. No system requirements.

**Age rating.** The IARC questionnaire for "All Other App Types", answered honestly. Online Content is Yes, because the app plays whatever the user's provider sends, which gives 18+ everywhere (ESRB Adults Only). Store policy 11.11.2 asks for an accurate rating.

**Listing.** English (United States).

- The description opens with what the app needs, as policy 10.2.4 asks: it supplies no channels, playlists or subscriptions, and the user connects their own provider.
- Screenshots and artwork come from the fake provider with made-up titles, as for the README ([development](../contributing/development.md#artwork)), and stay at a PEGI 12 level (policy 11.1) whatever the app's rating.
- Search terms name the formats it reads, never providers or channels.
- Copyright "Copyright © 2026 Wout Stiens", as in the app and the package.
- **Additional license terms** carry the GPL-3.0 source offer ([licences](licences.md#microsoft-store)).

**Submission options.** Publishing hold: "Don't publish this submission until I select Publish now". The `runFullTrust` capability needs a justification: Mr. Streamer is an Electron app, which runs as a full-trust Win32 process like every Electron app packaged as MSIX. It starts its bundled ffmpeg and ffprobe as child processes and serves playback through a local proxy on 127.0.0.1. It installs no drivers or services, doesn't start with Windows and writes only to its own data folder.

**Notes for certification**, under Supplemental info > Additional Testing Information. The Description field won't save a link and the Credentials table refuses one too, so the notes say how to find the reviewers' playlist: open the public repository Mr-Streamer-OSS/certification-playlist on GitHub, open `reviewer.m3u`, choose Raw and copy the address. Then connect with **Use an M3U link** and no login. The notes also say that the demo is live TV only, without a guide, that Movies and Series need a provider that offers them, that titles and channels for adults stay hidden until Settings > General > For adults, and that the app asks before sending a login over http. Never give Microsoft a real subscription.

## The reviewers' playlist

[Mr-Streamer-OSS/certification-playlist](https://github.com/Mr-Streamer-OSS/certification-playlist) lists five channels that broadcasters stream free on their own watch-live pages: Al Jazeera English, DW English, DW Español, DW Arabic and ABC News Australia. Check what reviewers will see against it:

```
https://raw.githubusercontent.com/Mr-Streamer-OSS/certification-playlist/main/reviewer.m3u
```

It holds only broadcasters' own official streams that are free worldwide, on their own domains or CDNs, each with its official page cited. No aggregators, restreams, redirectors or geo-blocked streams, and logos only from the broadcaster's own domain. Its README links only, claims no affiliation, leaves the rights with the broadcasters and gives `hello@mrstreamer.app` for removal requests. Wout approves any change to its channels.
