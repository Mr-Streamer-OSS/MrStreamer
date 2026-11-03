# Android notices

The manifest combines exactly the packages owning sources in Metro's Android release bundle
and Maven coordinates resolved by Gradle's release runtime classpath, including arrow-only
coordinates such as Hermes. Tooling and optional packages appear only if Metro bundles their
sources. The app and bundled workspace packages use the Android app version and repository
licence. Settings imports only the small `summary.json`; the licences route loads full notices.

After `pnpm install --frozen-lockfile` in `apps/android`, export the release bundle and its map,
then regenerate the native report with JDK 17 and the Android SDK available:

```sh
cd apps/android
pnpm exec expo export --platform android --source-maps --output-dir ../../.local/android-license-bundle
cd android
./gradlew :app:dependencies --configuration releaseRuntimeClasspath --console=plain > ../licenses/releaseRuntimeClasspath.txt
cd ../../..
python3 apps/android/scripts/licenses.py .local/android-license-bundle/_expo/static/js/android/*.map
```

The generator records the map's source paths in `bundle-sources.json` for reproducible package
coverage checks against the installed lockfile versions. Review and commit that input, the
native report, manifest and summary when dependencies or bundled code change. Bundling and
dependency resolution do not establish installed Android or runtime qualification.

The generator reads installed package notices, Maven parent licences and Expo's npm-local Maven
repositories. It stops on an unresolved notice instead of creating a partial manifest.
`notice-sources.json` pins upstream notices for packages that omit them from npm. Downloads are
cached in the checkout's ignored `.local/`, keyed by URL, lockfile, native report and source
overrides; local files are always read afresh. Refresh provenance when those packages change.
The overrides use React notices for its marker packages, Jimp 0.16.1 for the compact build,
and pinned upstream notices added after publication for standard-navigation and structured-headers.

For obsolete OSI MIT licence links, the full SPDX MIT text accompanies copyright headers
retained from the published source archive. Licence templates do not replace bundled notices.
