# What plays

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

## Known limits

- Subtitles and teletext aren't shown yet.
- When a channel carries several sound tracks, the first one plays.
- Surround sound that needs converting plays as stereo.
- Interlaced channels that play directly, common in European HD broadcasts, aren't deinterlaced; fast motion can show fine horizontal lines.
- Movies and series aren't available yet; Mr. Streamer shows live channels.

## When a channel won't play

Mr. Streamer tells you why:

- **Channel unavailable**: the provider has no stream for that channel right now. Try again later or pick another channel.
- **Stream refused**: the provider turned the stream down, usually because another device uses your subscription's connection.
- **Couldn't reconnect**: the stream stopped arriving and reconnecting didn't help, often a network problem.
- **Can't play this channel**: the channel uses a format Mr. Streamer can't play or convert. Please [report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with the channel's name and the details shown.
