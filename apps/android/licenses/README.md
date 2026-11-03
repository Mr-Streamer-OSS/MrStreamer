# Android notices

The manifest combines every JavaScript package version in Android's lockfile, including tooling
and optional packages for other hosts, installed native modules and Maven components resolved by
Gradle's release runtime classpath. Local Gradle projects are represented by their package notices.
The app and workspace packages use the Android app version and repository licence. The generator
writes the small `summary.json` beside the manifest for Settings; only the licences route loads
the full notices.

At packaging, after `pnpm install --frozen-lockfile` in `apps/android`, regenerate the native
input with JDK 17 and the Android SDK available:

```sh
cd apps/android/android
./gradlew :app:dependencies --configuration releaseRuntimeClasspath --console=plain > ../licenses/releaseRuntimeClasspath.txt
cd ../../..
python3 apps/android/scripts/licenses.py
```

The generator reads published package and Maven notices, including full licence texts, and
fails when it cannot obtain one. Downloads are cached in the checkout's ignored `.local/`.
Review and commit both the report and manifest when dependencies change. No Mac build,
installed Android build or runtime qualification is implied by the dependency report.

The generator reads installed package notices and obtains optional packages absent on this host
from their published npm archives. It follows Maven parent licences and reads Expo's npm-local
Maven repositories. It stops on an unresolved notice instead of creating a partial manifest.
`notice-sources.json` pins upstream notices for packages that omit them from npm. Downloads are
keyed by URL, the lockfile, native report and source overrides; local files are always read afresh.
Refresh their provenance when those packages change.
The overrides use React notices for its marker packages, Jimp 0.16.1 for the compact build,
and the pinned upstream notices added after publication for standard-navigation and
structured-headers.

For obsolete OSI MIT licence links, the full SPDX MIT text accompanies copyright headers
retained from the published source archive. Licence templates do not replace bundled notices.
