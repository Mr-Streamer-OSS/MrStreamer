# Licences and sources

> For maintainers. What every installer, release and Store submission must carry so Mr. Streamer and what it bundles can be distributed under their licences. [Development](../contributing/development.md#third-party-notices) describes how the notices are built.

Mr. Streamer is GPL-3.0-only. The bundled ffmpeg is GPL-2.0-or-later, because it's built with `--enable-gpl --enable-libx264`. Check this page before changing what the installers ship, how releases are published or withdrawn, or the Store listing.

## In the app

Settings > About shows:

- The app's own licence: its copyright, the lack of warranty, where the source is, then the repository's `LICENSE`. GPL-3.0 sections 4 and 5 ask for all of these in an app with an interactive interface. The entry is under `components` in `apps/desktop/licences.config.json`.
- Every component the installers ship, with its licence. The build fails when one has none (see [development](../contributing/development.md#third-party-notices)). That includes the MinGW-w64 runtime and winpthreads, which the Windows ffmpeg links in statically.
- Chromium's credits, which hold Node.js's licence and those of the LGPL parts inside Chromium, and Electron's MIT licence. Every installer keeps `LICENSES.chromium.html` and `LICENSE.electron.txt`: beside the executable on Linux and Windows, in the app's Resources on macOS.
- Source links: the commit the build comes from (`__BUILD_COMMIT__`), Chromium's source at its exact tag and Node.js's at its tag.
- The privacy policy at `https://mrstreamer.app/privacy`, which redirects to `docs/privacy.md` on `main`. Keep that file where it is.

## FFmpeg and x264 sources

- Every release, nightlies included, attaches the FFmpeg and x264 source archives that `apps/desktop/scripts/build-ffmpeg.sh` builds from, at the SHA-256 it pins. FFmpeg's notice in About links the archives on its own release.
- Each installer's `resources/ffmpeg/README.txt` names both versions, the configure line and the toolchain that built them.
- The release workflow caches the ffmpeg build by the hash of `build-ffmpeg.sh`, so each binary matches the script at its commit.
- **Never delete a release.** It holds the only copy of the sources owed to everyone who installed it: GPL-2.0 asks for three years, GPL-3.0 section 6(d) "for as long as needed". To stop offering a bad release, take its update files away instead, as [releasing](releasing.md#recovery) describes.

## Microsoft Store

- Only stable releases go to the Store, so every Store package has a release with its sources. The package carries the same notices as the direct download, and they link that release.
- GPL-3.0 section 6(d) allows the sources on another server with clear directions next to the object code. About, the notices and the listing give them.
- The listing's **Additional license terms** say the app is free software under GPL-3.0-only, with links to `LICENSE` and to the releases. Without them, Microsoft's Standard Application License Terms apply, and they forbid reverse engineering and copies beyond what the app allows, which GPL-3.0 section 10 rules out.
- Free, with Partner Center's organizational licensing defaults, and nothing that encrypts or locks the package. The Store's signature limits none of the GPL's rights.

## TMDB and JustWatch

- About shows TMDB's logo, less prominent than the app's own marks, and "This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB" ([TMDB's API terms](https://www.themoviedb.org/api-terms-of-use), section 3).
- Nothing from TMDB older than six months is used or kept (section 1.C, `apps/desktop/src/main/ondemand/metadata.ts`).
- Where titles stream comes from JustWatch, credited in About and the Services tab.
- The built-in key belongs to a TMDB account registered for non-commercial use. Charging, ads or selling access needs TMDB's written agreement (section 2). Review the terms again before any income, donations included.
- TMDB's terms forbid an app used mainly for pornographic content. The app asks TMDB about titles for adults only while the viewer has turned them on.
