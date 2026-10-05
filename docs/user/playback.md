# What plays

## Live channels

Mr. Streamer plays live channels your provider delivers as MPEG-TS, the format most Xtream Codes providers use, and radio channels that send plain MP3 or AAC audio.

An M3U playlist lists most channels as HLS, addresses ending in `.m3u8`. Those play as they arrive, without converting: H.264 video with AAC or MP3 sound everywhere, and HEVC on macOS. Where a stream offers several sound tracks, subtitles or closed captions, **Sound** and **CC** list them as on any channel, and another sound track plays without the channel starting again. Mr. Streamer leaves out playlist entries it can't play at all: DASH (`.mpd`) and addresses that don't start with `http` or `https`, such as `rtmp`.

Most channels play directly. For the rest, Mr. Streamer converts only what the player can't handle, on your computer, while you watch:

| The channel sends                                                  | What happens                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| H.264 video with AAC or MP3 sound                                  | Plays directly                                                                |
| Sound in MP2, AC-3 (Dolby Digital) or E-AC-3                       | The sound is converted to stereo AAC; the picture stays as it is              |
| HEVC (H.265) video on macOS                                        | Plays directly, including 10-bit and 4K                                       |
| HEVC video on Windows or Linux without a hardware decoder          | The picture is converted to H.264; 4K is reduced to 1080p                     |
| MPEG-2 video                                                       | The picture is converted to H.264 and deinterlaced                            |
| A picture the player can't decode because the broadcast is damaged | Mr. Streamer retries once with the picture re-encoded, which hides the damage |
| Several sound tracks                                               | The one in the language you picked last plays, else the channel's first       |
| DVB subtitles                                                      | Drawn over the picture                                                        |
| Teletext subtitles and closed captions                             | Shown under the picture                                                       |

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

A movie starts about a second after you choose it. Skipping into what's already loaded is instant; skipping further away starts it again from there, which takes about a second too. With subtitles on, the picture starts as soon as without them, and the subtitles already on screen at that moment follow as soon as Mr. Streamer has read them: "Subtitles loading" shows at the top right meanwhile.

## Playing on a TV

Mr. Streamer sends what you watch to a TV on your network: with AirPlay on macOS, and with Google Cast on Windows. The Linux builds play on the computer only. The TV fetches the stream from your computer, so the computer has to stay on and on the same network for as long as the TV plays. Mr. Streamer keeps it awake meanwhile.

Press the TV button beside the volume, or **O**. On Windows, pick a Cast device from the list. On macOS the button opens Apple's own AirPlay list, where a TV may ask for a code the first time. What you watch plays on here until the TV answers, and **This computer** cancels.

While the TV plays:

- The controls in Mr. Streamer work the TV: pause, skipping, the scrubber, the next episode, channel up and down, and the volume where the TV lets an app set it. They show what the TV last confirmed. After a skip the scrubber stays where you put it, with a ring where the TV still is, until the TV catches up.
- **Back** and **Escape** leave the player and the TV plays on. A bar at the foot of every page says what plays where, with Stop and **Play here**; clicking what plays opens its controls again.
- **Stop** ends the stream and keeps the TV, so the next thing you play goes there too. **Disconnect** in the bar then lets the TV go.
- **Play here** ends playback on the TV and carries on in Mr. Streamer from where the TV was, with the same sound and subtitles.
- Home and Live TV show no preview, since your subscription's one connection is the TV's.
- Closing the window on macOS leaves the TV playing, and the Dock icon brings its controls back. Quitting Mr. Streamer ends it.
- How far you got in a movie or episode is saved as it is on your computer.

| What you play                                              | What the TV gets                                    |
| ---------------------------------------------------------- | --------------------------------------------------- |
| H.264 video with AAC sound                                 | Sent as it is                                       |
| Other video or sound, such as HEVC or Dolby Digital        | Converted to H.264 and stereo AAC on your computer  |
| Text subtitles of a movie or episode                       | Shown by the TV                                     |
| Subtitles stored as pictures, teletext and closed captions | Play on this computer only; the menu says Here only |
| A channel's subtitles                                      | Play on this computer only                          |

A movie or episode starts later on a TV than on your computer, and so does a skip to a part the TV hasn't loaded: your computer cuts the stream into pieces of a few seconds for it. For the same reason a channel plays some seconds behind what your computer would show.

## Known limits

- Live subtitles show from their next line after you turn them on, and another sound track starts the channel again, except on HLS channels.
- An HLS channel shows the subtitles its stream lists and the closed captions in its picture. DVB subtitles and teletext inside an HLS stream don't show.
- Surround sound that needs converting plays as stereo.
- After you skip in a movie or episode, the subtitle already on screen at that moment can't always be had: Mr. Streamer reads only a little of the file for it, and only while the picture can spare the connection. That works for MKV files when the subtitle began shortly before, and for MP4 files with text subtitles; a line that began long before, a slow connection, and other kinds of files leave it out. "Subtitles unavailable" then shows for a few seconds, the movie plays on, and the subtitles are back from the next line.
- Closed captions come from the CEA-608 data most broadcasts carry. A channel or file that sends captions only in the newer CEA-708 form shows none.
- Converting an HEVC or Xvid picture uses much more of your computer's processor than playing it as it is.
- A damaged broadcast can take more than ten seconds to start, while Mr. Streamer retries it with the picture re-encoded.
- Interlaced channels that play directly, common in European HD broadcasts, aren't deinterlaced; fast motion can show fine horizontal lines.
- On a TV, a movie or episode plays at normal speed, subtitle timing can't be shifted, and the mini player is off, since it has no picture to show. Video the TV could play itself, such as HEVC, is still converted on your computer.
- The keyboard's media keys and your system's media controls work a TV only while Mr. Streamer's window is open.
- Playing on a TV is new. If yours doesn't show up or doesn't play, please [report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with its make and model.

## When something won't play

Mr. Streamer tells you why:

- **Channel unavailable**: the provider has no stream for that channel right now. Try again later or pick another channel.
- **Stream refused**: the provider turned the stream down, usually because another device uses your subscription's connection. On a public playlist it usually means the channel isn't offered in your country.
- **Couldn't reconnect**: the stream stopped arriving and reconnecting didn't help, often a network problem.
- **Can't play this channel** or **Can't play this title**: it uses a format Mr. Streamer can't play or convert. Please [report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with its name and the details shown.
- **Not available**: the provider has no file for that movie or episode right now; some providers list titles whose files are gone.
- **… didn't answer**, **… connection lost**, **… got no stream** or **… can't play this**, with your TV's name: see [Playing on a TV](troubleshooting.md#playing-on-a-tv).
