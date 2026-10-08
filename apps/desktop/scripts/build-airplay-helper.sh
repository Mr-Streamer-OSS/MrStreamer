#!/usr/bin/env bash
# Builds the helper Mr. Streamer plays on AirPlay receivers with: a small Swift program around
# AVPlayer and the system's list of receivers, which the app starts and speaks to over stdin and
# stdout. Electron can't AirPlay a stream itself.
#
#   scripts/build-airplay-helper.sh mac-arm64         on an Apple silicon Mac
#   scripts/build-airplay-helper.sh --key mac-arm64   prints what the result depends on, for a cache
#
# Needs Xcode or its command line tools, for swiftc and the macOS SDK. The sources are in
# native/airplay. The result is one executable for macOS 12 and later, with its Info.plist built
# in, in vendor/airplay/<target>, where electron-builder picks it up. The linker signs it ad hoc;
# packaging signs it again with the rest of the app.
#
# The key is a hash of everything the executable is built from: the sources, the Info.plist, this
# script, which holds the target and flags, and the compiler and SDK that build it. A cache of
# vendor/airplay/<target> under that key holds only this unsigned output; release signatures are
# made on the copy in the app and never reach it.
set -euo pipefail

key=false
if [[ ${1:-} == --key ]]; then
  key=true
  shift
fi
target=${1:?usage: scripts/build-airplay-helper.sh [--key] mac-arm64}
case $target in
  mac-arm64) triple=arm64-apple-macos12.0 ;;
  *)
    echo "Unknown target $target" >&2
    exit 1
    ;;
esac
if [[ $(uname -s) != Darwin ]]; then
  echo "The AirPlay helper builds only on macOS." >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
source=$root/native/airplay
out=$root/vendor/airplay/$target

if $key; then
  {
    echo "$triple"
    xcrun swiftc --version 2>&1
    xcrun --sdk macosx --show-sdk-version
    xcrun --sdk macosx --show-sdk-build-version
    shasum -a 256 < "$0"
    (cd "$source" && LC_ALL=C shasum -a 256 Info.plist *.swift)
  } | shasum -a 256 | cut -d' ' -f1
  exit 0
fi

rm -rf "$out"
mkdir -p "$out"
xcrun swiftc -O -swift-version 5 -target "$triple" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$source/Info.plist" \
  -o "$out/MrStreamerAirPlay" "$source"/*.swift
du -h "$out/MrStreamerAirPlay"
