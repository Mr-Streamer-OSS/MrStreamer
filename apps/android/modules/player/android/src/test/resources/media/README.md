# Player fixtures

Four seconds of ffmpeg's `testsrc2` picture at 160x90 and 10 fps with silent sound, made here
for these tests, so nothing in them is anyone else's. Remake them with:

```sh
V="-f lavfi -i testsrc2=size=160x90:rate=10:duration=4"
A="-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000"
B="-f lavfi -i anullsrc=channel_layout=5.1:sample_rate=48000"
q="-hide_banner -loglevel error -y"
ffmpeg $q $V $A -t 4 -c:v libx264 -g 10 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest -fflags +bitexact -map_metadata -1 h264-aac.mp4
ffmpeg $q $V $A -t 4 -c:v libx264 -g 10 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest -fflags +bitexact h264-aac.ts
ffmpeg $q $V $A -t 4 -c:v mpeg2video -g 10 -b:v 60k -c:a mp2 -b:a 64k -shortest -fflags +bitexact mpeg2-mp2.ts
printf '1\n00:00:00,000 --> 00:00:02,000\nHello\n' > sub.srt
ffmpeg $q $V $A $B -i sub.srt -t 4 -map 0:v -map 1:a -map 2:a -map 3:s -c:v libx265 -x265-params log-level=error -g 10 -pix_fmt yuv420p -c:a:0 ac3 -b:a:0 64k -c:a:1 eac3 -b:a:1 96k -c:s srt -metadata:s:a:0 language=eng -metadata:s:a:1 language=deu -metadata:s:s:0 language=nld -shortest -fflags +bitexact hevc-ac3-eac3-srt.mkv
rm sub.srt
ffmpeg $q $V $A -t 4 -c:v libvpx-vp9 -g 10 -b:v 50k -c:a libopus -b:a 24k -shortest -fflags +bitexact vp9-opus.webm
ffmpeg $q $V $A -t 4 -c:v libx265 -x265-params log-level=error -g 10 -pix_fmt yuv420p10le -tag:v hvc1 -c:a eac3 -b:a 96k -shortest -fflags +bitexact hevc10-eac3.mp4
ffmpeg $q $V $A -t 4 -c:v libx264 -g 10 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest -f hls -hls_time 2 -hls_list_size 0 -hls_segment_filename 'hls/segment%d.ts' hls/index.m3u8
printf 'This is not a stream.\n%.0s' $(seq 1 200) > not-media.bin
```
