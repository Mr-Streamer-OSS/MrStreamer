# Android notices

The manifest combines shipped JavaScript from the release Metro source map, installed native
packages and Maven components resolved by
Gradle's release runtime classpath. Build-only JavaScript tooling is omitted. Local Gradle
projects are represented by their package notices. The app and workspace packages use the
Android app version and repository licence. Every displayed count comes from the manifest.

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

The generator exports a release bundle into ignored scratch space to enumerate shipped
JavaScript, reads every bundled package notice, follows Maven parent licences and reads Expo's
npm-local Maven repositories. It stops on an unresolved notice instead of creating a partial
manifest. `notice-sources.json` pins upstream notices for packages that omit them from npm:
client-only declares MIT and points to React; standard-navigation declares MIT and its upstream
repository added the missing notice after 0.0.5. These source overrides do not create native
component lists. Refresh their provenance when those packages change.

For obsolete OSI MIT licence links, the full SPDX MIT text accompanies copyright headers
retained from the published source archive. Licence templates do not replace bundled notices.
