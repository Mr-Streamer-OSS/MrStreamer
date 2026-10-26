#!/usr/bin/env bash
# Local signed archives and explicit App Store Connect exports. Run heavy work with
# `onmac run -- onmac-job`; signing uses the fleet's existing identity and profile only.
set -euo pipefail

usage() {
  echo "Usage: testflight.sh archive | export internal-only|app-store | upload internal-only|app-store" >&2
  exit 1
}
command=${1:-}
intent=${2:-}
case "$command" in
  archive) [[ $# == 1 ]] || usage ;;
  export|upload) [[ $# == 2 && ( $intent == internal-only || $intent == app-store ) ]] || usage ;;
  *) usage ;;
esac

cd "$(dirname "$0")/.."
archive=build/MrStreamer.xcarchive
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit local changes first: the archive and export must identify one commit." >&2
  exit 1
fi
: "${APPLE_TEAM_ID:?Use the fleet-managed signing interface.}"
: "${IOS_PROVISIONING_PROFILE:?Set the UUID of the existing App Store provisioning profile.}"
[[ $APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ && $IOS_PROVISIONING_PROFILE =~ ^[a-fA-F0-9-]{36}$ ]] || {
  echo "Invalid signing team or profile UUID." >&2
  exit 1
}

case "$command" in
  archive)
    if [[ -e "$archive" ]]; then
      echo "Archive already exists; retain it before starting another candidate." >&2
      exit 1
    fi
    source=$(git rev-parse HEAD)
    pnpm install --frozen-lockfile
    scripts/build-ffmpeg.sh ios
    CI=1 npx expo prebuild --platform ios --clean
    # Hold the Settings inventory to the actual JavaScript packages and native pods.
    node scripts/licences.ts --check --pods ios/Podfile.lock
    # Keep the composed Metro/Hermes map with the exact bundle from this archive.
    xcodebuild archive -workspace ios/MrStreamer.xcworkspace -scheme MrStreamer \
      -configuration Release -destination generic/platform=iOS -archivePath "$archive" \
      DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Manual \
      CODE_SIGN_IDENTITY='Apple Distribution' PROVISIONING_PROFILE_SPECIFIER="$IOS_PROVISIONING_PROFILE" \
      SOURCEMAP_FILE="$PWD/build/main.jsbundle.map" | xcbeautify
    app="$archive/Products/Applications/MrStreamer.app"
    if [[ ! -s "$app/main.jsbundle" || ! -s build/main.jsbundle.map ]]; then
      echo "The archive needs its embedded JavaScript and matching source map." >&2
      exit 1
    fi
    [[ $(git rev-parse HEAD) == "$source" && -z "$(git status --porcelain)" ]] || {
      echo "Source changed during the archive; candidate not accepted." >&2
      exit 1
    }
    printf '%s\n' "$source" >build/source.txt
    find "$archive" -type f -exec shasum -a 256 {} \; >build/archive.sha256
    shasum -a 256 build/main.jsbundle.map >>build/archive.sha256
    echo "commit $source"
    for key in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion MinimumOSVersion UIDeviceFamily; do
      /usr/libexec/PlistBuddy -c "Print :$key" "$app/Info.plist"
    done
    ;;
  export|upload)
    if [[ ! -s build/source.txt || $(cat build/source.txt) != "$(git rev-parse HEAD)" ]]; then
      echo "No archive of this commit: run archive first. Rebase or source changes require a rebuild." >&2
      exit 1
    fi
    shasum -a 256 -c build/archive.sha256 >/dev/null
    internal=false
    [[ $intent == internal-only ]] && internal=true
    destination=export
    [[ $command == upload ]] && destination=upload
    # Export never uploads. Both destinations preserve the archived version/build, with an
    # intentional internal-only restriction or regular App Store distribution eligibility intent.
    cat >build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict>
    <key>app.mrstreamer.player</key><string>$IOS_PROVISIONING_PROFILE</string>
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
  <key>testFlightInternalTestingOnly</key><$internal/>
</dict></plist>
PLIST
    auth=()
    if [[ $command == upload ]]; then
      auth=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" \
        -authenticationKeyIssuerID "$ASC_ISSUER_ID")
    fi
    xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist build/ExportOptions.plist \
      -exportPath "build/$command-$intent" "${auth[@]}" | xcbeautify
    echo "$command intent=$intent source=$(cat build/source.txt); Apple processing/eligibility requires separate readback."
    ;;
esac
