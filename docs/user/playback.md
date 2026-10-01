# What plays

## Live channels

Mr. Streamer plays live channels your provider delivers as MPEG-TS, the format most Xtream Codes providers use, and radio channels that send plain MP3 or AAC audio.

Most channels play directly. For the rest, Mr. Streamer converts only what the player can't handle, on your computer, while you watch:

| The channel sends                                                  | What happens                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| H.264 video with AAC or MP3 sound                                  | Plays directly                                                                |
| Sound in MP2, AC-3 (Dolby Digital) or E-AC-3                       | The sound is converted to stereo AAC; the picture stays as it is              |
| HEVC (H.265) video on macOS                                        | Plays directly, including 10-bit and 4K                                       |
| HEVC video on Windows or Linux without a hardware decoder          | The picture is converted to H.264; 4K is reduced to 1080p                     |
| MPEG-2 video                                                       | The picture is converted to H.264 and deinterlaced                            |
| A picture the player can't decode because the broadcast is damaged | Mr. Streamer retries once with the picture re-encoded, which hides the damage |

Converted channels take a moment longer to start, about a second, and use more of your computer's processor, especially when the picture is converted.

## Movies and episodes

Providers keep movies and episodes as files, mostly MKV and MP4 and a few AVI. Mr. Streamer reads which picture, sound and subtitle tracks a file holds when you open it, then plays it from where you ask with the tracks you pick. As with channels, only what the player can't handle is converted:

| The file carries                                         | What happens                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| H.264 video with AAC, Opus or FLAC sound                 | Plays as it is                                                            |
| Dolby Digital (AC-3 or E-AC-3), DTS, TrueHD or MP3 sound | Converted to stereo AAC, unless your system plays it as it is             |
| HEVC (H.265) video                                       | Plays as it is on macOS; converted to H.264 where there's no HEVC decoder |
| MPEG-4 Part 2 (Xvid) or MPEG-2 video                     | Converted to H.264                                                        |
| SubRip, ASS or MP4 text subtitles                        | Shown under the picture                                                   |
| Subtitles stored as pictures (Blu-ray, DVD, DVB)         | Drawn over the picture                                                    |
| Teletext subtitles and closed captions                   | Shown under the picture, like text subtitles                              |

A movie starts about a second after you choose it. Skipping into what's already loaded is instant; skipping further away starts it again from there, which takes about a second too.

## Known limits

- Live channels show no subtitles or teletext, and play their first sound track.
- Surround sound that needs converting plays as stereo.
- After you skip in a movie or episode, picture subtitles, teletext and captions already on screen at that moment show again from the next line.
- Converting an HEVC or Xvid picture uses much more of your computer's processor than playing it as it is.
- A damaged broadcast can take more than ten seconds to start, while Mr. Streamer retries it with the picture re-encoded.
- Interlaced channels that play directly, common in European HD broadcasts, aren't deinterlaced; fast motion can show fine horizontal lines.

## When something won't play

Mr. Streamer tells you why:

- **Channel unavailable**: the provider has no stream for that channel right now. Try again later or pick another channel.
- **Stream refused**: the provider turned the stream down, usually because another device uses your subscription's connection.
- **Couldn't reconnect**: the stream stopped arriving and reconnecting didn't help, often a network problem.
- **Can't play this channel** or **Can't play this title**: it uses a format Mr. Streamer can't play or convert. Please [report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with its name and the details shown.
- **Not available**: the provider has no file for that movie or episode right now; some providers list titles whose files are gone.
