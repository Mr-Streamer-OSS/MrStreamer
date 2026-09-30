#!/usr/bin/env bash
# Builds the small ffmpeg that Mr. Streamer ships to convert streams its player cannot decode.
#
#   scripts/build-ffmpeg.sh mac-arm64    on an Apple silicon Mac
#   scripts/build-ffmpeg.sh linux-x64    on x64 Linux
#   scripts/build-ffmpeg.sh win-x64      on Windows in an MSYS2 MINGW64 shell, or cross-compiled
#                                        on x64 Linux with mingw-w64
#
# Needs a C compiler, make, nasm, pkg-config, git and curl; a Linux cross build also needs
# x86_64-w64-mingw32-gcc.
# Sources are pinned: FFmpeg by SHA-256, x264 by commit. The result lands in vendor/ffmpeg/<target>
# with the licences and the exact configuration, where electron-builder picks it up. The build
# keeps only what the conversion uses: MPEG-TS in and out, the decoders for the codecs IPTV
# streams carry, the AAC and x264 encoders, and the deinterlace and scale filters.
set -euo pipefail

target=${1:?usage: scripts/build-ffmpeg.sh mac-arm64|linux-x64|win-x64}
FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55

root=$(cd "$(dirname "$0")/.." && pwd)
work=${XDG_CACHE_HOME:-$HOME/.cache}/mr-streamer/ffmpeg-build/$target
out=$root/vendor/ffmpeg/$target
prefix=$work/prefix
jobs=$(getconf _NPROCESSORS_ONLN)

x264_flags=(--enable-static --disable-cli --enable-pic --disable-opencl --bit-depth=8 --chroma-format=420)
ffmpeg_flags=()
executable=ffmpeg
case $target in
  mac-arm64)
    export MACOSX_DEPLOYMENT_TARGET=12.0
    ;;
  linux-x64) ;;
  win-x64)
    ffmpeg_flags+=(--extra-ldflags=-static --pkg-config=pkg-config)
    if [[ $(uname -s) != MINGW* ]]; then
      x264_flags+=(--host=x86_64-w64-mingw32 --cross-prefix=x86_64-w64-mingw32-)
      ffmpeg_flags+=(--target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32-
        --enable-cross-compile)
    fi
    executable=ffmpeg.exe
    ;;
  *)
    echo "Unknown target $target" >&2
    exit 1
    ;;
esac

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

mkdir -p "$work"
cd "$work"
archive=ffmpeg-$FFMPEG_VERSION.tar.xz
if [[ ! -f $archive || $(sha256 "$archive") != "$FFMPEG_SHA256" ]]; then
  curl -sSfL -o "$archive" "https://ffmpeg.org/releases/$archive"
fi
if [[ $(sha256 "$archive") != "$FFMPEG_SHA256" ]]; then
  echo "$archive does not match its pinned SHA-256" >&2
  exit 1
fi
rm -rf ffmpeg x264 "$prefix"
mkdir ffmpeg
tar -xJf "$archive" -C ffmpeg --strip-components 1
git init -q x264
git -C x264 fetch -q --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
git -C x264 -c advice.detachedHead=false checkout -q FETCH_HEAD

(cd x264 && ./configure --prefix="$prefix" "${x264_flags[@]}" >/dev/null && make -j"$jobs" >/dev/null && make install >/dev/null)

features=(
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug
  --disable-programs --enable-ffmpeg --disable-avdevice
  --enable-gpl --enable-libx264 --enable-swscale --enable-swresample
  --enable-protocol=pipe,file
  --enable-demuxer=mpegts
  --enable-muxer=mpegts
  --enable-parser=h264,hevc,mpegvideo,mpegaudio,aac,aac_latm,ac3,dca,opus
  --enable-decoder=h264,hevc,mpeg1video,mpeg2video,mp2,mp2float,mp3,mp3float,aac,aac_latm,ac3,eac3,dca,opus
  --enable-encoder=aac,libx264
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb
  --enable-filter=yadif,scale,format,aresample,aformat,anull,null
)
configure=(
  --prefix="$prefix"
  --pkg-config-flags=--static
  --extra-cflags="-I$prefix/include"
  --extra-ldflags="-L$prefix/lib"
  "${features[@]}"
  ${ffmpeg_flags[@]+"${ffmpeg_flags[@]}"}
)
(cd ffmpeg && PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure "${configure[@]}" >/dev/null ||
  { tail -n 20 ffbuild/config.log >&2; exit 1; })
make -C ffmpeg -j"$jobs" >/dev/null

rm -rf "$out"
mkdir -p "$out"
cp "ffmpeg/$executable" "$out/"
case $target in
  mac-arm64) strip -x "$out/$executable" ;;
  linux-x64) strip "$out/$executable" ;;
  win-x64) "$(command -v x86_64-w64-mingw32-strip || command -v strip)" "$out/$executable" ;;
esac
cp ffmpeg/COPYING.GPLv2 "$out/LICENSE-FFmpeg.txt"
cp x264/COPYING "$out/LICENSE-x264.txt"
cat >"$out/README.txt" <<EOF
FFmpeg $FFMPEG_VERSION with x264 $X264_COMMIT, built for $target by scripts/build-ffmpeg.sh
in the Mr. Streamer source repository. Both are licensed under the GNU GPL, version 2 or later.
Sources: https://ffmpeg.org/releases/$archive (SHA-256 $FFMPEG_SHA256)
         https://code.videolan.org/videolan/x264/-/tree/$X264_COMMIT
Configuration: ${features[*]}
EOF
echo "Built $out/$executable ($(du -h "$out/$executable" | cut -f1))"
