#!/usr/bin/env bash
# Cache the distro's complete download set, tied by the workflow to the runner image and week.
# Restoring packages keeps ffprobe and the same codecs as the cold apt installation.
set -euo pipefail

cache_dir=${1:?Pass the task-owned package cache directory}
mkdir -p "$cache_dir"
cache_dir=$(cd "$cache_dir" && pwd)
started=$(date +%s%3N)

phase() {
  local name=$1
  shift
  local before
  before=$(date +%s%3N)
  "$@"
  printf 'ffmpeg-setup %s_ms=%s\n' "$name" "$(( $(date +%s%3N) - before ))"
}

if [[ -f "$cache_dir/SHA256SUMS" ]]; then
  (cd "$cache_dir" && sha256sum --check SHA256SUMS)
  # Reject extra packages too, rather than installing a file outside the verified set.
  (cd "$cache_dir" && sha256sum ./*.deb | diff - SHA256SUMS)
  # APT orders pre-dependencies even when the verified files are installed entirely offline.
  phase cached_install sudo apt-get install -y -qq --no-download \
    -o "Dir::Cache::archives=$cache_dir" -o APT::Keep-Downloaded-Packages=true "$cache_dir"/*.deb
else
  phase apt_index sudo apt-get update -qq
  phase package_install sudo apt-get install -y -qq \
    -o "Dir::Cache::archives=$cache_dir" -o APT::Keep-Downloaded-Packages=true ffmpeg
  # A cold image may already contain every package. Such a run has no portable download set.
  if compgen -G "$cache_dir/*.deb" >/dev/null; then
    (cd "$cache_dir" && sha256sum ./*.deb > SHA256SUMS)
  fi
fi

# A successful installation must produce both tools. CI must never silently omit media tests.
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -encoders
ffmpeg -hide_banner -decoders
ffmpeg -hide_banner -muxers
printf 'ffmpeg-setup total_ms=%s\n' "$(( $(date +%s%3N) - started ))"
