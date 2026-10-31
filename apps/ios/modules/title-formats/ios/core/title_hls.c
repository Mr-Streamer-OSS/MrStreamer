// See title_hls.h. How the stream is made:
//
// - The cuts are keyframes of the picture the file's index lists. Matroska's demuxer reads its
//   Cues only on the first seek, so opening seeks once and then takes the index as it stands;
//   reading later adds entries that the plan never uses. Without Cues FFmpeg's seek would read
//   the whole file to find keyframes, so the index may take INDEX_BYTES_MOST at most.
// - Title time 0 is the first cut. A segment is about SEGMENT_S long; a gap in the index longer
//   than SEGMENT_MOST_S, or an index that stops short of the end, leaves the file unsupported
//   rather than with a playlist that would be wrong.
// - Matroska stores presentation times only. A segment's pictures keep their order, and their
//   decode times are their presentation times sorted, less the segment's reorder delay so none
//   is after its presentation. The muxer writes negative composition offsets and takes that
//   delay off again (its first packet, the cut's keyframe, has the earliest presentation), so
//   the decode timeline of segment k runs exactly from cut k to cut k+1, however it was reached.
// - Matroska rounds times to its tick, often a millisecond. Sound whose frames all have one
//   length is placed on its frame grid, anchored at the first packet opening read, so frames
//   follow each other without the gaps or overlaps the rounding would leave.
// - A segment has the picture's packets from its cut's keyframe up to the next cut's, and each
//   sound track's packets whose time is between the two cuts, made in one pass of the file and
//   written per rendition. Made in order, the packets read past a cut are kept for the next
//   segment; made after a seek, and at open, the read starts at the cut's cluster, or one cut
//   earlier when sound of this segment may lie before it. A muxer may store sound ahead of the
//   picture, so sound for the first cut can lie in clusters before the first cut's: opening
//   reads the file's first clusters up to the picture's first keyframe and keeps that sound
//   (within LEAD_PACKETS_MOST and LEAD_BYTES_MOST) for whenever the read starts at the first cut.
// - A sound track may end before the picture, pause, or start late. Sound is waited for until the
//   picture is LATE_SOUND_S past the cut, and a track with nothing near where playing starts
//   isn't offered. AVPlayer's clock stops where the chosen sound stops, so each frame of a
//   track's grid that has no packet gets a frame of silence: its rendition runs the whole
//   title. The silence is built for AAC-LC and MP3, and encoded once with FFmpeg's encoder for
//   AC-3 and E-AC-3 when that writes frames like the track's. A track without one may start or
//   end EDGE_S inside the picture; a segment where it has a gap elsewhere is refused, with a
//   reason, when that track is chosen, rather than left to stall. The session fails with it,
//   and opening the title again, from where it stopped, plays the default sound.
// - Each rendition's MP4 is written by a muxer of its own, fed the packets and flushed twice:
//   with delay_moov the first flush writes the header, which for AC-3 and E-AC-3 the muxer can
//   only write once it has parsed a packet, and the second the fragment. A segment keeps the
//   fragment, the initialization segment the header.
// - AVPlayer doesn't take MP3 in fragmented MP4; HLS carries it as packed audio. An MP3
//   rendition has no initialization segment, and each of its segments is an ID3 tag with the
//   MPEG-2 transport stream time of its first frame (33 bits of a 90 kHz clock) followed by the
//   frames as they are. A frame may take part of its data from up to the last 511 bytes of the
//   frames before it (the bit reservoir), so playing from a segment reached by a seek, its first
//   few frames may not decode fully.
// - A text subtitle track is a WebVTT rendition cut at the picture's cuts. Every line read of it,
//   in any segment's pass, after a seek too, is kept as cue text for the title's life; a segment
//   holds each kept line on screen during it, so a line spanning segments is in each, as HLS has
//   it. A track that outgrows what a title keeps (see keep_cue) says so in each segment instead. The forced lines of a language are in its regular track's
//   rendition too, which AVPlayer shows in place of the forced one once chosen.
// - A file holds a line only where it begins, so a pass from a seek doesn't read the line on
//   screen there, nor one a muxer stored ahead of its time. The file's index (Cues), which
//   FFmpeg and mkvmerge write for every subtitle packet, says when each line begins, how long it
//   lasts and in which cluster it is: those lines of a chosen rendition's segment that no read
//   found are read from their clusters, RECALLS_MOST a segment and RECALL_BYTES_MOST past the
//   start of each cluster. FFmpeg keeps neither an index entry's length nor which
//   track number is whose stream, so opening keeps the file's start, whose SeekHead says where
//   the Cues are and whose Tracks number the streams, and the Cues are read again once a
//   rendition is chosen. A line the index leaves out shows only where a pass reads it.
// - A text track whose frames this FFmpeg can't decode, zlib or bzip2 compressed or encrypted, is
//   named with the picture subtitles as one the stream doesn't carry.
#include "title_hls.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avstring.h>
#include <libavutil/bprint.h>
#include <libavutil/mathematics.h>
#include <ctype.h>
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/** About how long a segment is: the first cut this long after the last. Seconds. */
#define SEGMENT_S 4.0
/** The longest gap between cuts. A longer one leaves the file unsupported. */
#define SEGMENT_MOST_S 20.0
/** A last segment shorter than this joins the one before it. */
#define LAST_LEAST_S 1.0
/** Segments a playlist lists at most: some 44 hours. */
#define SEGMENTS_MOST 40000
/**
 * The most one segment's packets, all renditions together, may hold. Two segments are kept and
 * one is being made, so this bounds what a title holds in memory.
 */
#define SEGMENT_BYTES_MOST (48 * 1024 * 1024)
/** Packets read past a segment's end at most, before giving up on the sound catching up. */
#define AHEAD_PACKETS_MOST 4096
/**
 * The most reading the index may take. A file's Cues are a small fraction of it; without them,
 * FFmpeg's seek would read the whole file to find keyframes, so the reading stops here instead.
 */
#define INDEX_BYTES_MOST (16 * 1024 * 1024)
/**
 * How far past a cut the picture may be read while sound of the segment before it is still
 * awaited. Muxers keep sound within about a second of the picture; a track with nothing by then
 * has nothing there.
 */
#define LATE_SOUND_S 5.0
/**
 * Packets read from the file's start for sound before the first cut's cluster at most, and the
 * bytes of sound kept from them.
 */
#define LEAD_PACKETS_MOST 1024
#define LEAD_BYTES_MOST (4 * 1024 * 1024)
/**
 * How far inside the picture a track that can't be filled with silence may start or end without
 * its segment being refused: AVPlayer starts its clock where such sound starts, and stops it
 * where it ends, so this little is lost at either end of the title.
 */
#define EDGE_S 0.1
/** Sound tracks offered at most. */
#define SOUNDS_MOST 8
/** Text subtitle tracks served at most, and other subtitle tracks named as unshown at most. */
#define TEXTS_MOST 16
#define UNSHOWN_MOST 16
/**
 * Bytes of cue text a track keeps at most, and the largest packet read as a line. A track with
 * more can't be shown: its segments are refused once chosen.
 */
#define TEXT_BYTES_MOST (4 * 1024 * 1024)
#define LINE_BYTES_MOST (64 * 1024)
/** Bytes of cue text a title keeps at most, every track together, and the largest packet read. */
#define CUE_BYTES_MOST (16 * 1024 * 1024)
#define PACKET_BYTES_MOST (1024 * 1024)
/** How long a line shows whose packet doesn't say. Seconds. */
#define UNTIMED_S 5.0
/**
 * Lines the index lists that one segment reads from their clusters at most, and how far past
 * the start of a line's cluster reading it may go.
 */
#define RECALLS_MOST 8
#define RECALL_BYTES_MOST (8 * 1024 * 1024)
/**
 * How much of the file's start opening keeps, for its SeekHead and Tracks, and the most read for
 * Tracks that lie past it.
 */
#define HEAD_BYTES (256 * 1024)
#define TRACKS_BYTES_MOST (1024 * 1024)
/** Segments kept after they were made, every rendition of each. */
#define KEPT 2
#define IO_BUFFER 65536

typedef struct Packets {
  AVPacket **items;
  int count, capacity;
  size_t bytes;
} Packets;

typedef struct Bytes {
  uint8_t *data;
  size_t size;
} Bytes;

/** A sound track offered as an audio rendition. */
typedef struct Sound {
  int stream;
  AVRational base;
  /** Samples per frame for sound on a frame grid, 0 otherwise; and its sample rate. */
  int frame, rate;
  /** The grid's anchor: the first packet opening read, in `base`. */
  int64_t first;
  /** That packet, which the initialization segment is written from. */
  AVPacket *sample;
  /** Empty for packed audio, which has none. */
  Bytes init;
  /** A frame of silence, filling where the track has none; NULL when one can't be made. */
  AVPacket *silence;
} Sound;

/** A line of a text subtitle track, as WebVTT cue text, at its times in the track's base. */
typedef struct Cue {
  int64_t from, to;
  char *text;
  /** WebVTT cue settings the file gives the line, or NULL. */
  char *settings;
} Cue;

/** A line of a text subtitle track the file's index lists. */
typedef struct Listed {
  /** When it begins and how long it lasts, in the track's base; the length -1 when unlisted. */
  int64_t time, duration;
  /** The file offset of its cluster. */
  int64_t cluster;
  /** Its cluster was read for it already, whatever that found; a read that failed doesn't count. */
  int tried;
} Listed;

/** A text subtitle track served as a WebVTT rendition. */
typedef struct Text {
  int stream;
  /** Its track's number in the file, which the index names it by; -1 when not known. */
  int64_t number;
  AVRational base;
  int forced;
  /** What its kept lines take; and whether a line went unkept for the bounds keep_cue keeps. */
  size_t bytes;
  int overflow;
  /** Its rendition was asked for: AVPlayer shows it, or may. */
  int wanted;
  /** Kept lines, by `from`. */
  Cue *cues;
  int count, capacity;
  /** The lines the index lists, by `time`. */
  Listed *listed;
  int listed_count, listed_capacity;
} Text;

/** Every rendition of one segment; a sound rendition without data was refused for a gap. */
typedef struct Made {
  int index; /* -1 when empty */
  Bytes renditions[1 + SOUNDS_MOST];
} Made;

struct TitleHls {
  TitleHlsSource source;
  int64_t position;
  /** Bytes reading may still take, or -1 for no limit. */
  int64_t budget;
  atomic_int interrupted;
  AVIOContext *io;
  AVFormatContext *input;
  int video;
  AVRational video_base;
  AVPacket *video_sample;
  Bytes video_init;
  Sound sounds[SOUNDS_MOST];
  int sound_count;
  /** Cuts in the picture's time base; cuts[count] is the end of the title. */
  int64_t *cuts;
  int count;
  /** Where playback starts, in title seconds; 0 for the start. */
  double start;
  /** The segment the input continues into without a seek, or -1. */
  int next;
  Packets ahead;
  /** Sound stored before the first cut's cluster, which a seek there doesn't read. */
  Packets lead;
  Made kept[KEPT];
  int kept_next;
  /** The last playlist or subtitle segment asked for. */
  char *text;
  Text texts[TEXTS_MOST];
  int text_count;
  /** The file's subtitle streams the stream doesn't carry, and which of them are encoded. */
  int unshown[UNSHOWN_MOST], unshown_encoded[UNSHOWN_MOST];
  /** How many it names, and how many more it has past UNSHOWN_MOST. */
  int unshown_count, unshown_more;
  /** Bytes every track's kept lines take together. */
  size_t cue_bytes;
  /** The file's first HEAD_BYTES, as opening read them, until the tracks are chosen. */
  uint8_t *head;
  int64_t head_size;
  /** Where the Segment's data starts, 0 when not known, and where its Cues are, -1 when not. */
  int64_t segment, cues;
  /** A bit for each segment whose pass was made: every line stored from its cut on was read. */
  uint8_t *passed;
  /** Whether the index's lines were read: 0 not yet, 1 read, -1 there are none to read. */
  int listing;
};

static const char *const MPEGURL = "application/vnd.apple.mpegurl";
static const char *const MP4 = "video/mp4";
static const char *const MPEG_AUDIO = "audio/mpeg";
static const char *const VTT = "text/vtt";

static void say(char *detail, size_t size, const char *text) {
  if (detail && size) av_strlcpy(detail, text, size);
}

static int read_packet(void *opaque, uint8_t *buffer, int size) {
  TitleHls *title = opaque;
  if (atomic_load(&title->interrupted)) return AVERROR_EXIT;
  if (title->budget == 0) return AVERROR(ERANGE);
  if (title->budget > 0 && size > title->budget) size = (int)title->budget;
  int read = title->source.read_at(title->source.opaque, title->position, buffer, size);
  if (read < 0) return atomic_load(&title->interrupted) ? AVERROR_EXIT : AVERROR(EIO);
  if (read == 0) return AVERROR_EOF;
  if (title->head && title->position <= title->head_size && title->position < HEAD_BYTES) {
    int64_t kept = FFMIN(read, HEAD_BYTES - title->position);
    memcpy(title->head + title->position, buffer, (size_t)kept);
    title->head_size = FFMAX(title->head_size, title->position + kept);
  }
  title->position += read;
  if (title->budget > 0) title->budget -= read;
  return read;
}

static int64_t seek(void *opaque, int64_t offset, int whence) {
  TitleHls *title = opaque;
  int64_t size = title->source.size;
  switch (whence & ~AVSEEK_FORCE) {
    case AVSEEK_SIZE:
      return size >= 0 ? size : AVERROR(ENOSYS);
    case SEEK_SET:
      break;
    case SEEK_CUR:
      offset += title->position;
      break;
    case SEEK_END:
      if (size < 0) return AVERROR(ENOSYS);
      offset += size;
      break;
    default:
      return AVERROR(EINVAL);
  }
  if (offset < 0) return AVERROR(EINVAL);
  title->position = offset;
  return offset;
}

static int interrupted(void *opaque) {
  return atomic_load(&((TitleHls *)opaque)->interrupted);
}

static TitleHlsResult failure(TitleHls *title, int error) {
  if (atomic_load(&title->interrupted) || error == AVERROR_EXIT) return TITLE_HLS_INTERRUPTED;
  if (error == AVERROR(ENOMEM)) return TITLE_HLS_NO_MEMORY;
  if (error == AVERROR(EIO)) return TITLE_HLS_READ_FAILED;
  return TITLE_HLS_UNSUPPORTED;
}

static int push(Packets *list, AVPacket *packet) {
  if (list->count == list->capacity) {
    int capacity = list->capacity ? list->capacity * 2 : 256;
    AVPacket **items = av_realloc_array(list->items, capacity, sizeof(*items));
    if (!items) return AVERROR(ENOMEM);
    list->items = items;
    list->capacity = capacity;
  }
  list->items[list->count++] = packet;
  list->bytes += packet->size;
  return 0;
}

static void clear(Packets *list) {
  for (int i = 0; i < list->count; i++) av_packet_free(&list->items[i]);
  list->count = 0;
  list->bytes = 0;
}

static void release(Packets *list) {
  clear(list);
  av_freep(&list->items);
  list->capacity = 0;
}

static double seconds(int64_t ts, AVRational base) { return ts * av_q2d(base); }

/** Samples per frame of the sound codecs whose frames are all one length. */
static int frame_samples(enum AVCodecID codec) {
  switch (codec) {
    case AV_CODEC_ID_AAC:
      return 1024;
    case AV_CODEC_ID_AC3:
    case AV_CODEC_ID_EAC3:
      return 1536;
    case AV_CODEC_ID_MP3:
      return 1152;
    default:
      return 0;
  }
}

/**
 * Samples per frame of the sound `sample` begins: for MP3, Layer III frames hold 1152 samples in
 * MPEG-1 and 576 in MPEG-2 and 2.5, as its header says, or its sample rate when the header can't
 * be read; for the others, `frame_samples`.
 */
static int sample_frame(const AVCodecParameters *par, const AVPacket *sample) {
  if (par->codec_id != AV_CODEC_ID_MP3) return frame_samples(par->codec_id);
  const uint8_t *x = sample ? sample->data : NULL;
  if (x && sample->size >= 4 && x[0] == 0xFF && (x[1] & 0xE0) == 0xE0 && ((x[1] >> 1) & 3) == 1) {
    int version = (x[1] >> 3) & 3; /* 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5 */
    if (version != 1) return version == 3 ? 1152 : 576;
  }
  return par->sample_rate >= 32000 ? 1152 : 576;
}

/** The sound codecs AVPlayer plays from fragmented MP4, copied as they are. */
static int sound_copyable(enum AVCodecID codec) { return frame_samples(codec) > 0; }

/** The time base a sound track is written in: its samples on a frame grid, else its own. */
static AVRational sound_base(const Sound *sound) {
  return sound->frame ? (AVRational){1, sound->rate} : sound->base;
}

/**
 * A sound packet's time from title time 0, in `sound_base`: on a frame grid, the anchor's time
 * plus a whole number of frames.
 */
static int64_t sound_time(const TitleHls *title, const Sound *sound, const AVPacket *packet) {
  AVRational base = sound_base(sound);
  int64_t origin = av_rescale_q(title->cuts[0], title->video_base, base);
  int64_t at = av_rescale_q(packet->pts, sound->base, base);
  if (!sound->frame) return at - origin;
  int64_t first = av_rescale_q(sound->first, sound->base, base);
  return first + llrint((double)(at - first) / sound->frame) * sound->frame - origin;
}

/** Whether a sound packet's time lies before the cut `at`, on the picture's clock. */
static int sound_before(const TitleHls *title, const Sound *sound, const AVPacket *packet,
                        int64_t at) {
  return av_compare_ts(sound_time(title, sound, packet), sound_base(sound), at - title->cuts[0],
                       title->video_base) < 0;
}

/** The offered sound track a packet belongs to, or NULL. */
static Sound *sound_of(TitleHls *title, const AVPacket *packet) {
  for (int i = 0; i < title->sound_count; i++) {
    if (title->sounds[i].stream == packet->stream_index) return &title->sounds[i];
  }
  return NULL;
}

/** Whether a track is served as packed audio, not fragmented MP4: MP3, as AVPlayer takes it. */
static int packed(const TitleHls *title, const Sound *sound) {
  return title->input->streams[sound->stream]->codecpar->codec_id == AV_CODEC_ID_MP3;
}

/** Where the first top-level box of `type` starts in an MP4, or with `after`, where it ends. */
static size_t box_offset(const uint8_t *data, size_t size, const char *type, int after) {
  size_t at = 0;
  while (at + 8 <= size) {
    uint64_t length = (uint64_t)data[at] << 24 | (uint64_t)data[at + 1] << 16 |
                      (uint64_t)data[at + 2] << 8 | data[at + 3];
    if (length == 1 && at + 16 <= size) {
      length = 0;
      for (int i = 0; i < 8; i++) length = length << 8 | data[at + 8 + i];
    }
    if (length < 8 || at + length > size) return SIZE_MAX;
    if (memcmp(data + at + 4, type, 4) == 0) return after ? at + (size_t)length : at;
    at += (size_t)length;
  }
  return SIZE_MAX;
}

static void put32(uint8_t *at, uint32_t value) {
  at[0] = value >> 24;
  at[1] = value >> 16;
  at[2] = value >> 8;
  at[3] = value;
}

typedef struct Bits {
  const uint8_t *data;
  int size, at;
} Bits;

/** Reads `count` bits, zeros past the end. */
static unsigned bits_read(Bits *bits, int count) {
  unsigned value = 0;
  for (int i = 0; i < count; i++, bits->at++) {
    int bit = bits->at < bits->size * 8 ? bits->data[bits->at >> 3] >> (7 - (bits->at & 7)) & 1 : 0;
    value = value << 1 | (unsigned)bit;
  }
  return value;
}

static void bits_put(uint8_t *data, int *at, int count, unsigned value) {
  for (int i = count - 1; i >= 0; i--, (*at)++) {
    if (value >> i & 1) data[*at >> 3] |= 0x80 >> (*at & 7);
  }
}

/** A key packet holding a copy of `size` bytes of `data`. */
static int frame_packet(const uint8_t *data, int size, AVPacket **made) {
  AVPacket *packet = av_packet_alloc();
  if (!packet || av_new_packet(packet, size) < 0) {
    av_packet_free(&packet);
    return AVERROR(ENOMEM);
  }
  memcpy(packet->data, data, (size_t)size);
  packet->flags = AV_PKT_FLAG_KEY;
  *made = packet;
  return 0;
}

/** The AAC audio object type `par`'s AudioSpecificConfig names, or 0 when it has none. */
static unsigned aac_type(const AVCodecParameters *par) {
  if (par->extradata_size < 1) return 0;
  Bits config = {par->extradata, par->extradata_size, 0};
  unsigned type = bits_read(&config, 5);
  return type == 31 ? 32 + bits_read(&config, 6) : type;
}

/**
 * Whether AVPlayer plays a sound track's codec in HLS: AAC only as AAC-LC or HE-AAC (v1, v2), as
 * Apple's HLS authoring specification lists it. A variant naming another AAC, such as AAC Main,
 * in its CODECS fails to open whole, the default sound with it; such a track isn't offered.
 */
static int sound_playable(const AVCodecParameters *par) {
  if (!sound_copyable(par->codec_id)) return 0;
  if (par->codec_id != AV_CODEC_ID_AAC) return 1;
  unsigned type = aac_type(par);
  return type == 0 || type == 2 || type == 5 || type == 29;
}

/**
 * An AAC-LC frame of silence for the channels `par`'s AudioSpecificConfig names: every channel
 * element has no scale factor bands, so all its coefficients are zero. None for other AAC (SBR,
 * 960-sample frames, a channel configuration of its own), which this can't silence.
 */
static int aac_silence(const AVCodecParameters *par, AVPacket **made) {
  // The channel elements of channel configurations 1 to 7: S single, C pair, L low frequency.
  static const char *const ELEMENTS[] = {"", "S", "C", "SC", "SCS", "SCC", "SCCL", "SCCCL"};
  if (par->extradata_size < 2 || aac_type(par) != 2) return 0;
  Bits config = {par->extradata, par->extradata_size, 5};
  if (bits_read(&config, 4) == 15) bits_read(&config, 24);
  unsigned channels = bits_read(&config, 4);
  if (channels < 1 || channels > 7) return 0;
  if (bits_read(&config, 1)) return 0; /* 960-sample frames */
  if (bits_read(&config, 1)) bits_read(&config, 14);
  bits_read(&config, 1);
  // A sync extension may say SBR follows the plain AAC.
  if (config.size * 8 - config.at >= 16 && bits_read(&config, 11) == 0x2b7 &&
      bits_read(&config, 5) == 5 && bits_read(&config, 1))
    return 0;
  uint8_t frame[32] = {0};
  int at = 0, tags[4] = {0};
  for (const char *element = ELEMENTS[channels]; *element; element++) {
    int id = *element == 'S' ? 0 : *element == 'C' ? 1 : 3;
    bits_put(frame, &at, 3, (unsigned)id);
    bits_put(frame, &at, 4, (unsigned)tags[id]++);
    if (id == 1) bits_put(frame, &at, 1, 0); /* common_window */
    for (int channel = 0; channel < (id == 1 ? 2 : 1); channel++) {
      bits_put(frame, &at, 8, 100); /* global_gain */
      // ics_info: reserved, one long window, its shape, max_sfb 0, no prediction.
      bits_put(frame, &at, 11, 0);
      // No pulse, TNS or gain control data; with no bands, no sections, scale factors or
      // spectral data.
      bits_put(frame, &at, 3, 0);
    }
  }
  bits_put(frame, &at, 3, 7); /* END */
  return frame_packet(frame, (at + 7) / 8, made);
}

/**
 * An MP3 frame of silence like `sample`'s: its header without CRC or padding, then side
 * information of zeros, so no granule has any data, and nothing else. None for a free-format
 * bitrate, whose frame length the header doesn't give.
 */
static int mp3_silence(const AVPacket *sample, AVPacket **made) {
  static const int KBPS[2][15] = {
      {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320},
      {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}};
  static const int RATES[4][3] = {{11025, 12000, 8000}, {0}, {22050, 24000, 16000},
                                  {44100, 48000, 32000}};
  const uint8_t *x = sample ? sample->data : NULL;
  if (!x || sample->size < 4 || x[0] != 0xFF || (x[1] & 0xE0) != 0xE0 || (x[1] >> 1 & 3) != 1)
    return 0;
  int version = x[1] >> 3 & 3, bitrate = x[2] >> 4, rate = x[2] >> 2 & 3;
  if (version == 1 || bitrate == 0 || bitrate == 15 || rate == 3) return 0;
  // Layer III: 144 bytes a frame per bit per second over the rate in MPEG-1, 72 in MPEG-2 and 2.5.
  uint8_t frame[1440] = {0};
  int size = (version == 3 ? 144 : 72) * KBPS[version != 3][bitrate] * 1000 / RATES[version][rate];
  frame[0] = 0xFF;
  frame[1] = x[1] | 1;
  frame[2] = x[2] & ~2;
  frame[3] = x[3];
  return frame_packet(frame, size, made);
}

/** How the first syncframe of an AC-3 or E-AC-3 packet is coded. */
typedef struct Dolby {
  int eac3, rate, acmod, lfe, blocks, size;
  /** AC-3's bitrate, in its table. */
  int bitrate;
} Dolby;

static const int DOLBY_RATES[3] = {48000, 44100, 32000};
static const int AC3_KBPS[19] = {32,  40,  48,  56,  64,  80,  96,  112, 128, 160,
                                 192, 224, 256, 320, 384, 448, 512, 576, 640};

/** Reads an AC-3 (bsid up to 8) or independent E-AC-3 (bsid 11 to 16) syncframe's header. */
static int dolby_header(const uint8_t *data, int size, Dolby *out) {
  if (size < 8 || data[0] != 0x0B || data[1] != 0x77) return 0;
  int bsid = data[5] >> 3; /* at the same place in both */
  Bits bits = {data, size, 16};
  Dolby d = {0};
  if (bsid <= 8) {
    bits_read(&bits, 16); /* crc1 */
    int fscod = (int)bits_read(&bits, 2), code = (int)bits_read(&bits, 6);
    if (fscod == 3 || code >= 38) return 0;
    bits_read(&bits, 8); /* bsid, bsmod */
    d.acmod = (int)bits_read(&bits, 3);
    if ((d.acmod & 1) && d.acmod != 1) bits_read(&bits, 2);
    if (d.acmod & 4) bits_read(&bits, 2);
    if (d.acmod == 2) bits_read(&bits, 2);
    d.lfe = (int)bits_read(&bits, 1);
    d.rate = DOLBY_RATES[fscod];
    d.bitrate = code >> 1;
    d.blocks = 6;
    // 16-bit words: 96 per kbit/s per kHz of the rate; at 44.1 kHz odd codes add a word.
    d.size = 2 * (AC3_KBPS[d.bitrate] * 96000 / d.rate) + (d.rate == 44100 ? 2 * (code & 1) : 0);
  } else if (bsid >= 11 && bsid <= 16) {
    d.eac3 = 1;
    if (bits_read(&bits, 2) != 0) return 0; /* not an independent substream */
    bits_read(&bits, 3);
    d.size = 2 * ((int)bits_read(&bits, 11) + 1);
    int fscod = (int)bits_read(&bits, 2);
    if (fscod == 3) return 0; /* half rates, which FFmpeg's encoder doesn't write */
    d.blocks = (int[]){1, 2, 3, 6}[bits_read(&bits, 2)];
    d.acmod = (int)bits_read(&bits, 3);
    d.lfe = (int)bits_read(&bits, 1);
    d.rate = DOLBY_RATES[fscod];
  } else {
    return 0;
  }
  *out = d;
  return 1;
}

/**
 * An AC-3 or E-AC-3 frame of silence coded like `sample`'s: FFmpeg's encoder given one frame
 * of zeros at the track's rate, channels and bitrate. None when the track's frames aren't ones
 * that encoder writes: two independent mono channels, E-AC-3 with fewer than six blocks a frame
 * or dependent substreams (over 5.1), or anything it writes differently.
 */
static int dolby_silence(const AVCodecParameters *par, const AVPacket *sample, AVPacket **made) {
  // The channels of acmod 1 to 7: 1/0, 2/0, 3/0, 2/1, 3/1, 2/2, 3/2.
  static const uint64_t LAYOUTS[8] = {0,
                                      AV_CH_LAYOUT_MONO,
                                      AV_CH_LAYOUT_STEREO,
                                      AV_CH_LAYOUT_SURROUND,
                                      AV_CH_LAYOUT_2_1,
                                      AV_CH_LAYOUT_4POINT0,
                                      AV_CH_LAYOUT_2_2,
                                      AV_CH_LAYOUT_5POINT0};
  Dolby want, got;
  if (!sample || !dolby_header(sample->data, sample->size, &want) || !LAYOUTS[want.acmod] ||
      want.blocks != 6 || want.size != sample->size)
    return 0;
  const AVCodec *codec = avcodec_find_encoder(par->codec_id);
  if (!codec) return 0;
  AVCodecContext *context = avcodec_alloc_context3(codec);
  AVFrame *frame = av_frame_alloc();
  AVPacket *packet = av_packet_alloc();
  int error = AVERROR(ENOMEM);
  if (!context || !frame || !packet) goto end;
  context->sample_rate = want.rate;
  context->sample_fmt = AV_SAMPLE_FMT_FLTP;
  av_channel_layout_from_mask(&context->ch_layout,
                              LAYOUTS[want.acmod] | (want.lfe ? AV_CH_LOW_FREQUENCY : 0));
  context->bit_rate = want.eac3 ? (int64_t)want.size * 8 * want.rate / 1536
                                : (int64_t)AC3_KBPS[want.bitrate] * 1000;
  // A rate, layout or bitrate the encoder refuses: no silence.
  if ((error = avcodec_open2(context, codec, NULL)) < 0) goto end;
  frame->nb_samples = context->frame_size;
  frame->format = context->sample_fmt;
  frame->sample_rate = context->sample_rate;
  if ((error = av_channel_layout_copy(&frame->ch_layout, &context->ch_layout)) < 0 ||
      (error = av_frame_get_buffer(frame, 0)) < 0)
    goto end;
  av_samples_set_silence(frame->extended_data, 0, frame->nb_samples,
                         frame->ch_layout.nb_channels, context->sample_fmt);
  if ((error = avcodec_send_frame(context, frame)) < 0) goto end;
  error = avcodec_receive_packet(context, packet);
  if (error == AVERROR(EAGAIN) && (error = avcodec_send_frame(context, NULL)) >= 0)
    error = avcodec_receive_packet(context, packet);
  if (error < 0) goto end;
  if (dolby_header(packet->data, packet->size, &got) && got.eac3 == want.eac3 &&
      got.rate == want.rate && got.acmod == want.acmod && got.lfe == want.lfe &&
      got.blocks == 6 && got.size == packet->size &&
      (want.eac3 ? got.size == want.size : got.bitrate == want.bitrate)) {
    packet->pts = packet->dts = AV_NOPTS_VALUE;
    packet->flags = AV_PKT_FLAG_KEY;
    *made = packet;
    packet = NULL;
  }
end:
  av_packet_free(&packet);
  av_frame_free(&frame);
  avcodec_free_context(&context);
  return error == AVERROR(ENOMEM) ? error : 0;
}

/** The track's frame of silence, or none: `silence` stays NULL. */
static int silence_of(const AVCodecParameters *par, const AVPacket *sample, AVPacket **silence) {
  switch (par->codec_id) {
    case AV_CODEC_ID_AAC:
      return aac_silence(par, silence);
    case AV_CODEC_ID_MP3:
      return mp3_silence(sample, silence);
    case AV_CODEC_ID_AC3:
    case AV_CODEC_ID_EAC3:
      return dolby_silence(par, sample, silence);
    default:
      return 0;
  }
}

/** The first frame of the grid at or after the cut `cut`, as sound_before tells it. */
static int64_t slot_at(const TitleHls *title, const Sound *sound, int64_t first, int64_t cut) {
  int64_t at = av_rescale_q_rnd(cut - title->cuts[0], title->video_base, sound_base(sound),
                                AV_ROUND_UP) - first;
  return at >= 0 ? (at + sound->frame - 1) / sound->frame : -(-at / sound->frame);
}

/**
 * Fills each frame of the grid between the cuts `from` and `to` that has no packet of
 * `packets`, a segment's, stamped and in order, with the track's silence, adding its bytes to
 * `*bytes`: AVPlayer's clock stops where the chosen sound stops, so a rendition has sound for
 * the whole of every segment. A track without silence is left as it is; 1 when it has a gap
 * more than EDGE_S inside the title, which this segment can't be played through. The frames are
 * those of one segment, so the work is bounded by its length.
 */
static int fill(const TitleHls *title, const Sound *sound, Packets *packets, int64_t from,
                int64_t to, size_t *bytes) {
  AVRational base = sound_base(sound);
  int64_t first = av_rescale_q(sound->first, sound->base, base) -
                  av_rescale_q(title->cuts[0], title->video_base, base);
  int64_t slots[2] = {slot_at(title, sound, first, from), slot_at(title, sound, first, to)};
  if (!sound->silence) {
    int64_t edge = (int64_t)(EDGE_S * sound->rate / sound->frame);
    int64_t inside[2] = {slot_at(title, sound, first, title->cuts[0]) + edge,
                         slot_at(title, sound, first, title->cuts[title->count]) - edge};
    int i = 0;
    for (int64_t slot = slots[0]; slot < slots[1]; slot++) {
      int64_t at = first + slot * sound->frame;
      int heard = 0;
      for (; i < packets->count && packets->items[i]->pts <= at; i++)
        heard |= packets->items[i]->pts == at;
      if (!heard && slot >= inside[0] && slot < inside[1]) return 1;
    }
    return 0;
  }
  Packets out = {0};
  int i = 0, error = 0;
  for (int64_t slot = slots[0]; slot < slots[1]; slot++) {
    int64_t at = first + slot * sound->frame;
    int heard = 0;
    for (; i < packets->count && packets->items[i]->pts <= at; i++) {
      heard |= packets->items[i]->pts == at;
      if ((error = push(&out, packets->items[i])) < 0) goto end;
      packets->items[i] = NULL;
    }
    if (heard) continue;
    AVPacket *silent = av_packet_clone(sound->silence);
    if (!silent || (error = push(&out, silent)) < 0) {
      av_packet_free(&silent);
      error = error < 0 ? error : AVERROR(ENOMEM);
      goto end;
    }
    silent->pts = silent->dts = at;
    silent->duration = sound->frame;
    *bytes += (size_t)silent->size;
  }
  for (; i < packets->count; i++) {
    if ((error = push(&out, packets->items[i])) < 0) goto end;
    packets->items[i] = NULL;
  }
  release(packets);
  *packets = out;
  return 0;
end:
  release(&out);
  return error;
}

/**
 * Writes a packed audio segment of `packets`, frames on the grid of `sound`: an ID3 tag whose
 * PRIV frame gives the first frame's MPEG-2 transport stream time, then the frames as they are.
 */
static int pack(const Sound *sound, const Packets *packets, Bytes *made) {
  static const char OWNER[] = "com.apple.streaming.transportStreamTimestamp";
  // The tag's header, its frame's header, the owner with its NUL and the eight-byte time.
  enum { PRIV = sizeof(OWNER) + 8, TAG = 10 + 10 + PRIV };
  size_t size = TAG;
  for (int i = 0; i < packets->count; i++) size += (size_t)packets->items[i]->size;
  uint8_t *x = av_malloc(size);
  if (!x) return AVERROR(ENOMEM);
  // Sizes in ID3v2.4 are syncsafe, seven bits a byte; both fit in one.
  memcpy(x, "ID3\x04\x00\x00\x00\x00\x00", 9);
  x[9] = TAG - 10;
  memcpy(x + 10, "PRIV\x00\x00\x00", 7);
  x[17] = PRIV;
  x[18] = x[19] = 0;
  memcpy(x + 20, OWNER, sizeof(OWNER));
  int64_t at = packets->count ? av_rescale(packets->items[0]->pts, 90000, sound->rate) : 0;
  uint64_t clock = (uint64_t)at & ((UINT64_C(1) << 33) - 1);
  put32(x + 20 + sizeof(OWNER), (uint32_t)(clock >> 32));
  put32(x + 24 + sizeof(OWNER), (uint32_t)clock);
  size_t offset = TAG;
  for (int i = 0; i < packets->count; i++) {
    memcpy(x + offset, packets->items[i]->data, (size_t)packets->items[i]->size);
    offset += (size_t)packets->items[i]->size;
  }
  made->data = x;
  made->size = size;
  return 0;
}

/**
 * Writes one rendition: the fragment of `packets`, whose times are in `base`, or with `packets`
 * NULL the initialization segment, written from `sample`.
 */
static int mux(const AVStream *in, AVRational base, int frame, Packets *packets,
               const AVPacket *sample, int index, Bytes *made) {
  AVFormatContext *out = NULL;
  AVDictionary *options = NULL;
  AVIOContext *io = NULL;
  uint8_t *bytes = NULL;
  AVPacket *copy = NULL;
  int error = avformat_alloc_output_context2(&out, NULL, "mp4", NULL);
  if (error < 0) return error;
  AVStream *st = avformat_new_stream(out, NULL);
  if (!st) {
    error = AVERROR(ENOMEM);
    goto end;
  }
  if ((error = avcodec_parameters_copy(st->codecpar, in->codecpar)) < 0) goto end;
  st->codecpar->codec_tag = 0;
  if (st->codecpar->codec_id == AV_CODEC_ID_HEVC) st->codecpar->codec_tag = MKTAG('h', 'v', 'c', '1');
  if (frame) st->codecpar->frame_size = frame;
  st->time_base = base;
  out->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
  av_dict_set(&options, "movflags",
              "frag_custom+delay_moov+default_base_moof+negative_cts_offsets+frag_discont", 0);
  av_dict_set(&options, "use_editlist", "0", 0);
  av_dict_set_int(&options, "fragment_index", index + 1, 0);
  if ((error = avio_open_dyn_buf(&io)) < 0) goto end;
  out->pb = io;
  if ((error = avformat_write_header(out, &options)) < 0) goto end;
  if (packets) {
    for (int i = 0; i < packets->count; i++) {
      AVPacket *packet = packets->items[i];
      packet->stream_index = 0;
      av_packet_rescale_ts(packet, base, st->time_base);
      if ((error = av_write_frame(out, packet)) < 0) goto end;
    }
  } else if (sample) {
    if (!(copy = av_packet_clone(sample))) {
      error = AVERROR(ENOMEM);
      goto end;
    }
    copy->stream_index = 0;
    copy->pts = copy->dts = 0;
    copy->duration = frame ? frame : 1;
    av_packet_rescale_ts(copy, base, st->time_base);
    if ((error = av_write_frame(out, copy)) < 0) goto end;
  }
  // The first flush writes the header, the second the fragment.
  if ((error = av_write_frame(out, NULL)) < 0) goto end;
  if (packets && (error = av_write_frame(out, NULL)) < 0) goto end;
  int length = avio_close_dyn_buf(io, &bytes);
  io = NULL;
  size_t from = packets ? box_offset(bytes, (size_t)length, "moof", 0) : 0;
  size_t to = packets ? (size_t)length : box_offset(bytes, (size_t)length, "moov", 1);
  if (from == SIZE_MAX || to == SIZE_MAX || to < from) {
    error = AVERROR_INVALIDDATA;
    goto end;
  }
  made->data = av_malloc(to - from + 1);
  if (!made->data) {
    error = AVERROR(ENOMEM);
    goto end;
  }
  memcpy(made->data, bytes + from, to - from);
  made->size = to - from;
  error = 0;
end:
  av_free(bytes);
  av_packet_free(&copy);
  if (io) {
    uint8_t *rest = NULL;
    avio_close_dyn_buf(io, &rest);
    av_free(rest);
  }
  if (out) out->pb = NULL;
  avformat_free_context(out);
  av_dict_free(&options);
  return error;
}

/** Plans the cuts from the picture's index. */
static TitleHlsResult plan(TitleHls *title, char *detail, size_t detail_size) {
  AVStream *video = title->input->streams[title->video];
  int entries = avformat_index_get_entries_count(video);
  if (entries < 1) {
    say(detail, detail_size, "The file lists no keyframes to cut at.");
    return TITLE_HLS_UNSUPPORTED;
  }
  // Matroska says how long the file is; MP4 says how long each track is.
  int64_t end = AV_NOPTS_VALUE;
  if (title->input->duration > 0) {
    int64_t start = title->input->start_time == AV_NOPTS_VALUE ? 0 : title->input->start_time;
    end = av_rescale_q(start + title->input->duration, AV_TIME_BASE_Q, title->video_base);
  } else if (video->duration > 0) {
    end = (video->start_time == AV_NOPTS_VALUE ? 0 : video->start_time) + video->duration;
  }
  if (end == AV_NOPTS_VALUE) {
    say(detail, detail_size, "The file doesn't say how long it is.");
    return TITLE_HLS_UNSUPPORTED;
  }
  title->cuts = av_malloc_array(entries + 1, sizeof(*title->cuts));
  if (!title->cuts) return TITLE_HLS_NO_MEMORY;
  int64_t step = llrint(SEGMENT_S / av_q2d(title->video_base));
  int64_t most = llrint(SEGMENT_MOST_S / av_q2d(title->video_base));
  int64_t least = llrint(LAST_LEAST_S / av_q2d(title->video_base));
  int count = 0;
  int64_t last = AV_NOPTS_VALUE;
  for (int i = 0; i < entries; i++) {
    const AVIndexEntry *entry = avformat_index_get_entry(video, i);
    if (!(entry->flags & AVINDEX_KEYFRAME) || entry->timestamp >= end) continue;
    if (last != AV_NOPTS_VALUE && entry->timestamp <= last) continue;
    if (last != AV_NOPTS_VALUE && entry->timestamp - last > most) break;
    if (last == AV_NOPTS_VALUE || entry->timestamp - title->cuts[count - 1] >= step)
      title->cuts[count++] = entry->timestamp;
    last = entry->timestamp;
  }
  if (count == 0 || end - last > most) {
    say(detail, detail_size, "The file's keyframe index leaves out too much of it.");
    return TITLE_HLS_UNSUPPORTED;
  }
  if (count > 1 && end - title->cuts[count - 1] < least) count--;
  if (count > SEGMENTS_MOST) {
    say(detail, detail_size, "The file is too long.");
    return TITLE_HLS_UNSUPPORTED;
  }
  title->cuts[count] = end;
  title->count = count;
  if (!(title->passed = av_mallocz((size_t)count / 8 + 1))) return TITLE_HLS_NO_MEMORY;
  return TITLE_HLS_OK;
}

/** The segment `at` seconds of the title fall in. */
static int segment_at(const TitleHls *title, double at) {
  int64_t ts = title->cuts[0] + llrint(at / av_q2d(title->video_base));
  int index = 0;
  while (index + 1 < title->count && title->cuts[index + 1] <= ts) index++;
  return index;
}

/** The text subtitle codecs served as WebVTT. */
static int text_codec(enum AVCodecID codec) {
  return codec == AV_CODEC_ID_SUBRIP || codec == AV_CODEC_ID_TEXT || codec == AV_CODEC_ID_ASS ||
         codec == AV_CODEC_ID_SSA || codec == AV_CODEC_ID_WEBVTT;
}

/** The served text track a packet belongs to, or NULL. */
static Text *text_of(TitleHls *title, const AVPacket *packet) {
  for (int i = 0; i < title->text_count; i++) {
    if (title->texts[i].stream == packet->stream_index) return &title->texts[i];
  }
  return NULL;
}

static const char *language_of(const AVStream *st) {
  const AVDictionaryEntry *language = av_dict_get(st->metadata, "language", NULL, 0);
  return language && *language->value && strcmp(language->value, "und") != 0 ? language->value
                                                                              : NULL;
}

/**
 * Whether rendition `track` carries the lines of text track `other`: its own, and a forced
 * track's in the regular track of the same language, as HLS has forced lines.
 */
static int folds(const TitleHls *title, int track, int other) {
  if (track == other) return 1;
  const Text *a = &title->texts[track], *b = &title->texts[other];
  if (a->forced || !b->forced) return 0;
  const char *x = language_of(title->input->streams[a->stream]);
  const char *y = language_of(title->input->streams[b->stream]);
  return x && y && strcmp(x, y) == 0;
}

/** Appends a character of text as WebVTT cue text holds it. */
static void vtt_char(AVBPrint *out, char c) {
  if (c == '&') av_bprintf(out, "&amp;");
  else if (c == '<') av_bprintf(out, "&lt;");
  else if (c == '>') av_bprintf(out, "&gt;");
  else av_bprint_chars(out, c, 1);
}

/** Starts a new line, unless the text is empty or a line just started: cue text has no blank line. */
static void vtt_break(AVBPrint *out) {
  if (out->len && out->str[out->len - 1] != '\n') av_bprint_chars(out, '\n', 1);
}

/**
 * SubRip's text as WebVTT: its <i>, <b> and <u> are WebVTT's too; other tags, such as <font>,
 * and the ASS overrides some files carry, go.
 */
static void from_subrip(const uint8_t *x, int size, AVBPrint *out) {
  for (int i = 0; i < size && x[i]; i++) {
    const uint8_t *end = NULL;
    if (x[i] == '{' && i + 1 < size && x[i + 1] == '\\') end = memchr(x + i, '}', size - i);
    // A tag's name begins with a letter or "/" and runs to its ">", without another "<".
    if (x[i] == '<' && i + 1 < size && (isalpha(x[i + 1]) || x[i + 1] == '/')) {
      end = memchr(x + i, '>', size - i);
      const uint8_t *other = memchr(x + i + 1, '<', size - i - 1);
      if (other && end && other < end) end = NULL;
    }
    if (end) {
      const uint8_t *tag = x + i + 1;
      int length = (int)(end - tag), closing = length > 0 && tag[0] == '/';
      char name = x[i] == '<' && length == 1 + closing ? (char)tolower(tag[closing]) : 0;
      if (name == 'i' || name == 'b' || name == 'u') av_bprintf(out, closing ? "</%c>" : "<%c>", name);
      i = (int)(end - x);
    } else if (x[i] == '\n') {
      vtt_break(out);
    } else if (x[i] != '\r') {
      vtt_char(out, (char)x[i]);
    }
  }
}

/**
 * An ASS line as Matroska keeps it, ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV and
 * Effect before its text, as WebVTT: italics, bold and underline as tags, \N as a new line and \h
 * as a no-break space. Other overrides, such as positions, go, and so do drawings.
 */
static void from_ass(const uint8_t *x, int size, AVBPrint *out) {
  int i = 0;
  for (int commas = 0; i < size && commas < 8; i++) commas += x[i] == ',';
  // The styles open now, italic, bold, underline, as WebVTT's tags; and drawing mode.
  static const char TAGS[3] = {'i', 'b', 'u'};
  int open[3] = {0}, drawing = 0;
  for (; i < size && x[i]; i++) {
    const uint8_t *end = x[i] == '{' ? memchr(x + i, '}', size - i) : NULL;
    if (end) {
      int want[3] = {open[0], open[1], open[2]};
      for (const uint8_t *at = x + i + 1; at < end; at++) {
        if (*at != '\\') continue;
        const uint8_t *name = ++at;
        while (at < end && isalpha(*at)) at++;
        int length = (int)(at - name);
        long value = strtol((const char *)at, NULL, 10);
        int number = at < end && isdigit(*at);
        if (length == 1 && (*name == 'i' || *name == 'u')) want[*name == 'u' ? 2 : 0] = number && value;
        // \b1 or a weight of 700 and over is bold.
        else if (length == 1 && *name == 'b') want[1] = number && (value == 1 || value >= 700);
        else if (length == 1 && *name == 'p') drawing = number && value > 0;
        else if (length >= 1 && *name == 'r') want[0] = want[1] = want[2] = 0;
        // An override's arguments, such as \t's, may hold overrides of their own: they go too.
        if (at < end && *at == '(') {
          const uint8_t *close = memchr(at, ')', (size_t)(end - at));
          at = close ? close : end;
        }
        at--;
      }
      for (int t = 2; t >= 0; t--) {
        if (open[t] && !want[t]) av_bprintf(out, "</%c>", TAGS[t]);
      }
      for (int t = 0; t < 3; t++) {
        if (!open[t] && want[t]) av_bprintf(out, "<%c>", TAGS[t]);
        open[t] = want[t];
      }
      i = (int)(end - x);
    } else if (drawing) {
      continue;
    } else if (x[i] == '\\' && i + 1 < size && (x[i + 1] == 'N' || x[i + 1] == 'n')) {
      vtt_break(out);
      i++;
    } else if (x[i] == '\\' && i + 1 < size && x[i + 1] == 'h') {
      av_bprintf(out, "\xc2\xa0");
      i++;
    } else if (x[i] == '\n') {
      vtt_break(out);
    } else if (x[i] != '\r') {
      vtt_char(out, (char)x[i]);
    }
  }
}

/** WebVTT's own cue text, as it is, but for carriage returns and blank lines. */
static void from_vtt(const uint8_t *x, int size, AVBPrint *out) {
  for (int i = 0; i < size && x[i]; i++) {
    if (x[i] == '\n') vtt_break(out);
    else if (x[i] != '\r') av_bprint_chars(out, (char)x[i], 1);
  }
}

/** The first kept line of the track that begins at or after `from`. */
static int first_from(const Text *text, int64_t from) {
  int low = 0, high = text->count;
  while (low < high) {
    int middle = (low + high) / 2;
    if (text->cues[middle].from < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

static int by_cue(const Cue *a, int64_t from, int64_t to, const char *text) {
  if (a->from != from) return a->from < from ? -1 : 1;
  if (a->to != to) return a->to < to ? -1 : 1;
  return strcmp(a->text, text);
}

/**
 * Keeps the line of a text track's packet, once: a line read again, after a seek or for the
 * index, is the same line. A packet past PACKET_BYTES_MOST or a line past LINE_BYTES_MOST is kept
 * as a line saying it is too large to show; one past the track's TEXT_BYTES_MOST or the title's
 * CUE_BYTES_MOST isn't kept, and the track is marked as one that can't be shown.
 */
static int keep_cue(TitleHls *title, Text *text, const AVPacket *packet) {
  if (packet->pts == AV_NOPTS_VALUE || !packet->data) return 0;
  enum AVCodecID codec = title->input->streams[text->stream]->codecpar->codec_id;
  AVBPrint line, settings;
  av_bprint_init(&line, 0, AV_BPRINT_SIZE_UNLIMITED);
  av_bprint_init(&settings, 0, AV_BPRINT_SIZE_UNLIMITED);
  int large = packet->size > PACKET_BYTES_MOST;
  if (!large && (codec == AV_CODEC_ID_ASS || codec == AV_CODEC_ID_SSA))
    from_ass(packet->data, packet->size, &line);
  else if (!large && codec == AV_CODEC_ID_WEBVTT) from_vtt(packet->data, packet->size, &line);
  else if (!large) from_subrip(packet->data, packet->size, &line);
  while (line.len && line.str[line.len - 1] == '\n') line.str[--line.len] = 0;
  size_t given = 0;
  const uint8_t *cue = av_packet_get_side_data(packet, AV_PKT_DATA_WEBVTT_SETTINGS, &given);
  for (size_t i = 0; cue && i < given && cue[i]; i++) {
    av_bprint_chars(&settings, cue[i] == '\n' || cue[i] == '\r' ? ' ' : (char)cue[i], 1);
  }
  // A line too large to keep shows, at its time, that it is.
  if (large || line.len + settings.len > LINE_BYTES_MOST) {
    av_bprint_clear(&line);
    av_bprint_clear(&settings);
    av_bprintf(&line, "This line is too large to show.");
  }
  int error = 0;
  char *kept = NULL, *placed = NULL;
  if (!av_bprint_is_complete(&line) || !av_bprint_is_complete(&settings)) {
    error = AVERROR(ENOMEM);
    goto end;
  }
  if (!line.len) goto end;
  int64_t from = packet->pts;
  int64_t to = from + (packet->duration > 0 ? packet->duration
                                            : llrint(UNTIMED_S / av_q2d(text->base)));
  int at = first_from(text, from);
  while (at < text->count && by_cue(&text->cues[at], from, to, line.str) < 0) at++;
  if (at < text->count && by_cue(&text->cues[at], from, to, line.str) == 0) goto end;
  // What a line takes, its own allocations too.
  size_t cost = line.len + settings.len + sizeof(Cue) + 64;
  if (text->bytes + cost > TEXT_BYTES_MOST || title->cue_bytes + cost > CUE_BYTES_MOST) {
    text->overflow = 1;
    goto end;
  }
  if (text->count == text->capacity) {
    int capacity = text->capacity ? text->capacity * 2 : 64;
    Cue *cues = av_realloc_array(text->cues, capacity, sizeof(*cues));
    if (!cues) {
      error = AVERROR(ENOMEM);
      goto end;
    }
    text->cues = cues;
    text->capacity = capacity;
  }
  if ((error = av_bprint_finalize(&line, &kept)) < 0 ||
      (settings.len && (error = av_bprint_finalize(&settings, &placed)) < 0))
    goto end;
  memmove(&text->cues[at + 1], &text->cues[at], (size_t)(text->count - at) * sizeof(Cue));
  text->cues[at] = (Cue){from, to, kept, placed};
  text->count++;
  text->bytes += cost;
  title->cue_bytes += cost;
  kept = placed = NULL;
end:
  av_free(kept);
  av_free(placed);
  av_bprint_finalize(&line, NULL);
  av_bprint_finalize(&settings, NULL);
  return error;
}

/**
 * Marks the listed lines of the track beginning at `time` as read: a line read and not kept,
 * such as an ASS drawing, isn't read again for the index.
 */
static void mark_read(Text *text, int64_t time) {
  int low = 0, high = text->listed_count;
  while (low < high) {
    int middle = (low + high) / 2;
    if (text->listed[middle].time < time) low = middle + 1;
    else high = middle;
  }
  for (; low < text->listed_count && text->listed[low].time == time; low++)
    text->listed[low].tried = 1;
}

/** Reads the next packet of the file, keeping a text track's line as it goes. */
static int read_frame(TitleHls *title, AVPacket *packet) {
  int error = av_read_frame(title->input, packet);
  Text *text = error < 0 ? NULL : text_of(title, packet);
  if (text && packet->pts != AV_NOPTS_VALUE) mark_read(text, packet->pts);
  if (text && (error = keep_cue(title, text, packet)) < 0) av_packet_unref(packet);
  return error;
}

/** Reads all `size` bytes at `offset` of the file, unless it ends first: how many, or -1. */
static int64_t read_whole(TitleHls *title, int64_t offset, uint8_t *buffer, int64_t size) {
  int64_t done = 0;
  while (done < size) {
    if (atomic_load(&title->interrupted)) return -1;
    int64_t want = size - done > IO_BUFFER ? IO_BUFFER : size - done;
    int read = title->source.read_at(title->source.opaque, offset + done, buffer + done, (int)want);
    if (read < 0) return -1;
    if (read == 0) break;
    done += read;
  }
  return done;
}

/**
 * An EBML number at `at` of `data`: an element's ID, with its marker, or its size, without; -1
 * when it runs past `size` or is longer than eight bytes. A size of all ones, unknown, is
 * INT64_MAX.
 */
static int64_t ebml(const uint8_t *data, int64_t size, int64_t *at, int id) {
  if (*at < 0 || *at >= size || !data[*at]) return -1;
  int length = 1;
  while (!(data[*at] & (0x80 >> (length - 1)))) length++;
  if (length > size - *at) return -1;
  int64_t value = id ? data[*at] : data[*at] & (0xFF >> length);
  int ones = value == (0xFF >> length);
  for (int i = 1; i < length; i++) {
    value = value << 8 | data[*at + i];
    ones &= data[*at + i] == 0xFF;
  }
  *at += length;
  return !id && ones ? INT64_MAX : value;
}

/**
 * The element at `*at`, inside `end`: its ID, where its data starts and how long it is, and `*at`
 * moved past it. 0 when there is none, or its data doesn't fit inside `end`, an unknown size
 * included: nothing past that is read.
 */
static int child(const uint8_t *data, int64_t end, int64_t *at, int64_t *id, int64_t *from,
                 int64_t *length) {
  int64_t here = *at;
  if ((*id = ebml(data, end, &here, 1)) < 0 || (*length = ebml(data, end, &here, 0)) < 0 ||
      *length > end - here)
    return 0;
  *from = here;
  *at = here + *length;
  return 1;
}

/** An unsigned integer element's value, of its first eight bytes at most. */
static uint64_t ebml_uint(const uint8_t *data, int64_t length) {
  uint64_t value = 0;
  for (int64_t i = 0; i < length && i < 8; i++) value = value << 8 | data[i];
  return value;
}

/**
 * Whether a track's ContentEncodings leave its frames as FFmpeg can't read them here: encrypted,
 * or compressed with zlib or bzip2, which this build of FFmpeg passes on still compressed.
 * Header stripping and LZO it undoes, and encodings of the codec's private data only don't count.
 */
static int encoded(const uint8_t *data, int64_t from, int64_t end) {
  int count = 0, unreadable = 0;
  for (int64_t at = from, id, start, length; child(data, end, &at, &id, &start, &length);) {
    if (id != 0x6240) continue;
    // ContentEncodingType 1, or a ContentEncryption, is encryption.
    count++;
    uint64_t scope = 1, type = 0, algo = 0;
    int compression = 0, encryption = 0;
    for (int64_t in = start, kind, s, l; child(data, start + length, &in, &kind, &s, &l);) {
      if (kind == 0x5032) scope = ebml_uint(data + s, l);
      if (kind == 0x5033) type = ebml_uint(data + s, l);
      if (kind == 0x5035) encryption = 1;
      if (kind != 0x5034) continue;
      compression = 1;
      for (int64_t c = s, k, s2, l2; child(data, s + l, &c, &k, &s2, &l2);) {
        if (k == 0x4254) algo = ebml_uint(data + s2, l2);
      }
    }
    // Without a ContentCompression, compression is zlib's, the default.
    if (!(scope & 1)) continue;
    if (type != 0 || encryption) unreadable = 3;
    else if ((!compression || algo < 2) && !unreadable) unreadable = 1;
  }
  // FFmpeg reads one encoding at most; with more it reads none.
  return unreadable ? unreadable : count > 1;
}

/**
 * Reads the Tracks element's data, from `from` to `end` of `data`: each stream's track number and
 * whether its frames are encoded in a way this can't read. FFmpeg makes a stream of each track it
 * accepts, in their order; 0 when a stream's kind isn't its track's, which leaves both unknown.
 */
static int read_tracks(const TitleHls *title, const uint8_t *data, int64_t from, int64_t end,
                       int64_t *numbers, int *unreadable) {
  unsigned streams = title->input->nb_streams, made = 0;
  int64_t found[TEXTS_MOST + UNSHOWN_MOST + SOUNDS_MOST + 64];
  int encodings[sizeof(found) / sizeof(*found)] = {0};
  for (int64_t entry = from, kind, s, l; child(data, end, &entry, &kind, &s, &l);) {
    if (kind != 0xAE) continue;
    int64_t number = -1;
    uint64_t type = 0;
    char letter = 0;
    int unread = 0;
    for (int64_t in = s, k, s2, l2; child(data, s + l, &in, &k, &s2, &l2);) {
      if (k == 0xD7) number = (int64_t)ebml_uint(data + s2, l2);
      if (k == 0x83) type = ebml_uint(data + s2, l2);
      if (k == 0x86 && l2 > 0) letter = (char)data[s2];
      if (k == 0x6D80) unread = encoded(data, s2, s2 + l2);
    }
    // The tracks FFmpeg makes no stream of: of no kind it plays, or a codec of another kind.
    int video = type == 1, audio = type == 2, text = type == 0x11 || type == 0x21;
    if (!(video || audio || text) || !letter || (video && letter != 'V') ||
        (audio && letter != 'A') || (text && letter != 'D' && letter != 'S'))
      continue;
    if (made >= streams || made >= sizeof(found) / sizeof(*found)) return 0;
    enum AVMediaType made_kind = title->input->streams[made]->codecpar->codec_type;
    if ((video && made_kind != AVMEDIA_TYPE_VIDEO) || (audio && made_kind != AVMEDIA_TYPE_AUDIO) ||
        (type == 0x11 && made_kind != AVMEDIA_TYPE_SUBTITLE))
      return 0;
    encodings[made] = unread;
    found[made++] = number;
  }
  for (unsigned i = 0; i < made; i++) {
    numbers[i] = found[i];
    unreadable[i] = encodings[i];
  }
  return made > 0;
}

/**
 * Reads the file's start as opening read it, `title->head`: where its Segment's data starts,
 * which the index's positions count from, where its SeekHead says its Cues are, and its Tracks
 * (see read_tracks), from the start or, where they lie past it, from where the SeekHead says,
 * within TRACKS_BYTES_MOST. 0 when the Tracks couldn't be read: every number stays unknown.
 */
static int read_head(TitleHls *title, int64_t *numbers, int *unreadable) {
  const uint8_t *head = title->head;
  int64_t size = title->head_size, at = 0, id, from, length, tracks = -1;
  for (unsigned i = 0; i < title->input->nb_streams; i++) numbers[i] = -1;
  if (!child(head, size, &at, &id, &from, &length) || id != 0x1A45DFA3) return 0;
  // The Segment holds the rest of the file, beyond what the start holds.
  if (ebml(head, size, &at, 1) != 0x18538067 || ebml(head, size, &at, 0) < 0) return 0;
  title->segment = at;
  while (child(head, size, &at, &id, &from, &length)) {
    if (id == 0x1654AE6B) return read_tracks(title, head, from, from + length, numbers, unreadable);
    if (id != 0x114D9B74) continue;
    for (int64_t seek = from, kind, s, l; child(head, from + length, &seek, &kind, &s, &l);) {
      if (kind != 0x4DBB) continue;
      uint64_t named = 0;
      int64_t position = -1;
      for (int64_t in = s, k, s2, l2; child(head, s + l, &in, &k, &s2, &l2);) {
        if (k == 0x53AB && l2 == 4) named = ebml_uint(head + s2, 4);
        if (k == 0x53AC) position = (int64_t)ebml_uint(head + s2, l2);
      }
      if (position < 0 || position > INT64_MAX - title->segment) continue;
      if (named == 0x1C53BB6B) title->cues = title->segment + position;
      if (named == 0x1654AE6B) tracks = title->segment + position;
    }
  }
  if (tracks < 0) return 0;
  uint8_t header[16];
  int64_t got = read_whole(title, tracks, header, sizeof(header));
  at = 0;
  if (got < 0 || ebml(header, got, &at, 1) != 0x1654AE6B ||
      (length = ebml(header, got, &at, 0)) < 0 || length > TRACKS_BYTES_MOST)
    return 0;
  uint8_t *data = av_malloc(length ? (size_t)length : 1);
  if (!data) return 0;
  int64_t read = read_whole(title, tracks + at, data, length);
  int known = read == length && read_tracks(title, data, 0, length, numbers, unreadable);
  av_free(data);
  return known;
}

static int by_time(const void *a, const void *b) {
  const Listed *x = a, *y = b;
  if (x->time != y->time) return x->time < y->time ? -1 : 1;
  return (x->cluster > y->cluster) - (x->cluster < y->cluster);
}

/** Whether FFmpeg's index of stream `st` has every line listed: the same index, the same track. */
static int indexes(AVStream *st, const Listed *listed, int count) {
  for (int i = 0; i < count; i++) {
    int at = av_index_search_timestamp(st, listed[i].time, AVSEEK_FLAG_ANY);
    const AVIndexEntry *entry = at >= 0 ? avformat_index_get_entry(st, at) : NULL;
    if (!entry || entry->timestamp != listed[i].time || entry->pos != listed[i].cluster) return 0;
  }
  return 1;
}

/** Lists line `listed` for `text`. */
static int list(Text *text, Listed listed) {
  if (text->listed_count == text->listed_capacity) {
    int capacity = text->listed_capacity ? text->listed_capacity * 2 : 64;
    Listed *more = av_realloc_array(text->listed, capacity, sizeof(*more));
    if (!more) return AVERROR(ENOMEM);
    text->listed = more;
    text->listed_capacity = capacity;
  }
  text->listed[text->listed_count++] = listed;
  return 0;
}

/**
 * Reads the lines of each text track whose number is known that the file's index lists, within
 * INDEX_BYTES_MOST, once. A track's lines are kept only where FFmpeg's index of its stream, read
 * from the same Cues, has them all, and the same entry listed twice is one line. None when the
 * SeekHead names no Cues or they aren't Cues; a read that fails leaves them unread, failing the
 * request as any failed read does.
 */
static int list_cues(TitleHls *title) {
  int64_t at = 0, length;
  uint8_t header[16];
  if (title->cues < 0) {
    title->listing = -1;
    return 0;
  }
  int64_t got = read_whole(title, title->cues, header, sizeof(header));
  if (got < 0) return AVERROR(EIO);
  if (ebml(header, got, &at, 1) != 0x1C53BB6B || (length = ebml(header, got, &at, 0)) < 0 ||
      length > INDEX_BYTES_MOST) {
    title->listing = -1;
    return 0;
  }
  uint8_t *data = av_malloc(length ? (size_t)length : 1);
  if (!data) return AVERROR(ENOMEM);
  int64_t size = read_whole(title, title->cues + at, data, length);
  int error = size < 0 ? AVERROR(EIO) : 0;
  for (int64_t point = 0, kind, p0, part; !error && child(data, size, &point, &kind, &p0, &part);) {
    if (kind != 0xBB) continue;
    int64_t time = -1;
    for (int64_t in = p0, k, s, l; !error && child(data, p0 + part, &in, &k, &s, &l);) {
      if (k == 0xB3) time = (int64_t)ebml_uint(data + s, l);
      if (k != 0xB7 || time < 0) continue;
      int64_t track = -1, cluster = -1, duration = -1;
      for (int64_t field = s, f, s2, l2; child(data, s + l, &field, &f, &s2, &l2);) {
        uint64_t value = ebml_uint(data + s2, l2);
        if (f == 0xF7) track = (int64_t)value;
        if (f == 0xF1 && value <= (uint64_t)(INT64_MAX - title->segment)) cluster = (int64_t)value;
        if (f == 0xB2 && value <= INT64_MAX / 2) duration = (int64_t)value;
      }
      for (int t = 0; !error && cluster >= 0 && t < title->text_count; t++) {
        if (track >= 0 && title->texts[t].number == track)
          error = list(&title->texts[t], (Listed){time, duration, title->segment + cluster, 0});
      }
    }
  }
  av_free(data);
  if (error < 0) {
    for (int t = 0; t < title->text_count; t++) title->texts[t].listed_count = 0;
    return error;
  }
  for (int t = 0; t < title->text_count; t++) {
    Text *text = &title->texts[t];
    if (text->listed_count) qsort(text->listed, text->listed_count, sizeof(*text->listed), by_time);
    int kept = 0;
    for (int i = 0; i < text->listed_count; i++) {
      if (!kept || by_time(&text->listed[kept - 1], &text->listed[i]))
        text->listed[kept++] = text->listed[i];
    }
    text->listed_count = kept;
    if (!indexes(title->input->streams[text->stream], text->listed, text->listed_count))
      text->listed_count = 0;
  }
  title->listing = 1;
  return 0;
}

/** Whether a line beginning at `time` of the track is kept: the index lists it once it is. */
static int kept_at(const Text *text, int64_t time) {
  int at = first_from(text, time);
  return at < text->count && text->cues[at].from == time;
}

/** A time of the track in milliseconds of the title. */
static int64_t title_ms(const TitleHls *title, int64_t ts, AVRational base) {
  return av_rescale_q(ts, base, (AVRational){1, 1000}) -
         av_rescale_q(title->cuts[0], title->video_base, (AVRational){1, 1000});
}

/**
 * Reads listed line `listed` of track `text` from its cluster: from the picture's index entry at
 * or before it, the packets up to the line and any others of its time stored with it. Every line
 * read on the way is kept. The read leaves the input elsewhere.
 */
static int recall(TitleHls *title, Text *text, Listed *listed) {
  listed->tried = 1;
  AVStream *video = title->input->streams[title->video];
  const AVIndexEntry *from = NULL;
  for (int i = 0, entries = avformat_index_get_entries_count(video); i < entries; i++) {
    const AVIndexEntry *entry = avformat_index_get_entry(video, i);
    if (entry->pos <= listed->cluster && (!from || entry->pos > from->pos)) from = entry;
  }
  if (!from) return 0;
  title->next = -1;
  clear(&title->ahead);
  title->budget = listed->cluster - from->pos + RECALL_BYTES_MOST;
  int error = av_seek_frame(title->input, title->video, from->timestamp, AVSEEK_FLAG_BACKWARD);
  int found = 0;
  for (int i = 0; error >= 0 && i < AHEAD_PACKETS_MOST; i++) {
    AVPacket *packet = av_packet_alloc();
    if (!packet) {
      error = AVERROR(ENOMEM);
      break;
    }
    if ((error = read_frame(title, packet)) >= 0) {
      int line = packet->stream_index == text->stream && packet->pts != AV_NOPTS_VALUE;
      // Lines of one time are stored together: the first packet after them ends the read.
      if (line && packet->pts == listed->time) found = 1;
      else if (found || (line && packet->pts > listed->time)) error = AVERROR_EOF;
    }
    av_packet_free(&packet);
  }
  int over = title->budget == 0;
  title->budget = -1;
  // What reading past the budget left behind doesn't hold up the next read.
  title->io->error = 0;
  title->io->eof_reached = 0;
  if (atomic_load(&title->interrupted)) return AVERROR_EXIT;
  // A line not found within reach is left out, as a read that doesn't reach it would.
  if (over || error >= 0 || error == AVERROR_EOF || error == AVERROR_INVALIDDATA) return 0;
  // A read that failed, such as the provider's, is made again when the segment is asked again.
  listed->tried = 0;
  return error;
}

/**
 * Reads the lines segment `index` of rendition `track` holds that the index lists, that no read
 * kept and whose cluster lies before `before`, RECALLS_MOST at most, as `*budget` counts them:
 * those on screen as it begins, which began before, and those a muxer stored ahead of their
 * time. A listed line without a length counts when it is the last to begin before the segment.
 */
static int recall_for(TitleHls *title, int track, int index, int64_t before, int *budget) {
  if (title->listing == 0) {
    int error = list_cues(title);
    if (error < 0) return error;
  }
  int64_t a = title_ms(title, title->cuts[index], title->video_base);
  int64_t b = title_ms(title, title->cuts[index + 1], title->video_base);
  for (int t = 0; t < title->text_count; t++) {
    if (!folds(title, track, t)) continue;
    Text *text = &title->texts[t];
    int last = -1;
    for (int i = 0; i < text->listed_count; i++) {
      if (title_ms(title, text->listed[i].time, text->base) < a) last = i;
    }
    for (int i = 0; i < text->listed_count && *budget > 0; i++) {
      Listed *listed = &text->listed[i];
      int64_t from = title_ms(title, listed->time, text->base);
      int64_t to = listed->duration < 0 ? -1
                                        : title_ms(title, listed->time + listed->duration, text->base);
      int needed = from < b && (listed->duration < 0 ? from >= a || i == last : to > a);
      if (!needed || listed->tried || listed->cluster >= before || kept_at(text, listed->time))
        continue;
      (*budget)--;
      int error = recall(title, text, listed);
      if (error < 0) return error;
    }
  }
  return 0;
}

/**
 * Before a pass from a seek to segment `index`, reads the lines of every chosen rendition it
 * holds that are stored before the cluster the pass starts at, which it wouldn't read.
 */
static int recall_before(TitleHls *title, int index) {
  AVStream *video = title->input->streams[title->video];
  int at = av_index_search_timestamp(video, title->cuts[index], AVSEEK_FLAG_BACKWARD);
  const AVIndexEntry *entry = at >= 0 ? avformat_index_get_entry(video, at) : NULL;
  int budget = RECALLS_MOST;
  for (int t = 0; entry && t < title->text_count; t++) {
    if (!title->texts[t].wanted) continue;
    int error = recall_for(title, t, index, entry->pos, &budget);
    if (error < 0) return error;
  }
  return 0;
}

static int passed(const TitleHls *title, int index) {
  return title->passed[index / 8] >> (index % 8) & 1;
}

/** A WebVTT time, from milliseconds. */
static void vtt_time(AVBPrint *out, int64_t ms) {
  av_bprintf(out, "%02lld:%02d:%02d.%03d", (long long)(ms / 3600000), (int)(ms / 60000 % 60),
             (int)(ms / 1000 % 60), (int)(ms % 1000));
}

typedef struct Placed {
  int64_t from, to;
  const Cue *cue;
} Placed;

static int by_placed(const void *a, const void *b) {
  const Placed *x = a, *y = b;
  if (x->from != y->from) return x->from < y->from ? -1 : 1;
  if (x->to != y->to) return x->to < y->to ? -1 : 1;
  return strcmp(x->cue->text, y->cue->text);
}

/**
 * Segment `index` of subtitle rendition `track`: every kept line it carries on screen during the
 * segment, from title time 0, which the picture's time 0 is too. A line both a forced track and
 * its regular one hold is written once.
 */
static int write_vtt(const TitleHls *title, int track, int index, AVBPrint *out) {
  int64_t a = title_ms(title, title->cuts[index], title->video_base);
  int64_t b = title_ms(title, title->cuts[index + 1], title->video_base);
  int count = 0;
  for (int t = 0; t < title->text_count; t++) {
    if (folds(title, track, t)) count += title->texts[t].count;
  }
  Placed *placed = av_malloc_array(count ? count : 1, sizeof(*placed));
  if (!placed) return AVERROR(ENOMEM);
  count = 0;
  for (int t = 0; t < title->text_count; t++) {
    if (!folds(title, track, t)) continue;
    const Text *text = &title->texts[t];
    for (int i = 0; i < text->count; i++) {
      const Cue *cue = &text->cues[i];
      int64_t from = title_ms(title, cue->from, text->base), to = title_ms(title, cue->to, text->base);
      if (from < b && to > a && to > 0) placed[count++] = (Placed){from > 0 ? from : 0, to, cue};
    }
  }
  qsort(placed, count, sizeof(*placed), by_placed);
  av_bprintf(out, "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n");
  for (int i = 0; i < count; i++) {
    if (i > 0 && by_placed(&placed[i - 1], &placed[i]) == 0) continue;
    av_bprintf(out, "\n");
    vtt_time(out, placed[i].from);
    av_bprintf(out, " --> ");
    vtt_time(out, placed[i].to);
    if (placed[i].cue->settings) av_bprintf(out, " %s", placed[i].cue->settings);
    av_bprintf(out, "\n%s\n", placed[i].cue->text);
  }
  av_free(placed);
  return 0;
}

/** Reads the next packet of the offered tracks, taking any read ahead first. */
static int next_packet(TitleHls *title, Packets *ahead, int *at, AVPacket **out) {
  if (*at < ahead->count) {
    *out = ahead->items[*at];
    ahead->items[(*at)++] = NULL;
    return 0;
  }
  AVPacket *packet = av_packet_alloc();
  if (!packet) return AVERROR(ENOMEM);
  int error = read_frame(title, packet);
  if (error < 0) {
    av_packet_free(&packet);
    return error;
  }
  *out = packet;
  return 0;
}

/**
 * Moves the read to segment `index`'s cut, or one earlier when some offered sound track's first
 * packet there is already past the cut, so its sound may start before the cluster the seek
 * found. Read from the first cut, the lead comes first. What was read on the way stays in
 * `ahead`.
 */
static int reach(TitleHls *title, int index, Packets *ahead) {
  for (int from = index; from >= 0 && from >= index - 1; from--) {
    clear(ahead);
    int error = av_seek_frame(title->input, title->video, title->cuts[from], AVSEEK_FLAG_BACKWARD);
    if (error < 0) return error;
    for (int i = 0; from == 0 && i < title->lead.count; i++) {
      AVPacket *copy = av_packet_clone(title->lead.items[i]);
      if (!copy || push(ahead, copy) < 0) {
        av_packet_free(&copy);
        return AVERROR(ENOMEM);
      }
    }
    int seen[SOUNDS_MOST] = {0}, missing = title->sound_count, late = 0;
    int64_t until = title->cuts[index] + llrint(LATE_SOUND_S / av_q2d(title->video_base));
    for (int i = 0; missing > 0 && i < AHEAD_PACKETS_MOST; i++) {
      AVPacket *packet = i < ahead->count ? ahead->items[i] : av_packet_alloc();
      if (!packet) return AVERROR(ENOMEM);
      if (i == ahead->count) {
        if ((error = read_frame(title, packet)) < 0) {
          av_packet_free(&packet);
          if (error == AVERROR_EOF) break;
          return error;
        }
        if ((error = push(ahead, packet)) < 0) {
          av_packet_free(&packet);
          return error;
        }
      }
      Sound *sound = sound_of(title, packet);
      if (sound && packet->pts != AV_NOPTS_VALUE && !seen[sound - title->sounds]) {
        seen[sound - title->sounds] = 1;
        missing--;
        if (av_compare_ts(packet->pts, sound->base, title->cuts[index], title->video_base) >= 0)
          late = 1;
      }
      // A track with nothing near here has nothing to start before the cut either.
      if (packet->stream_index == title->video && packet->pts != AV_NOPTS_VALUE &&
          packet->pts >= until)
        break;
    }
    if (!late || from == 0 || from == index - 1) return 0;
  }
  return 0;
}

/**
 * Reads the file's first clusters, where opening left the read, up to the picture's first
 * keyframe, keeping the offered sound found there in the lead. A muxer may store sound ahead of
 * the picture, before the first cut's cluster, where a seek to the first cut doesn't read;
 * `prune` keeps only that. It reads LEAD_PACKETS_MOST packets and keeps LEAD_BYTES_MOST bytes at
 * most.
 */
static int read_lead(TitleHls *title) {
  for (int read = 0; read < LEAD_PACKETS_MOST && title->lead.bytes < LEAD_BYTES_MOST; read++) {
    AVPacket *packet = av_packet_alloc();
    if (!packet) return AVERROR(ENOMEM);
    int error = read_frame(title, packet);
    if (error < 0) {
      av_packet_free(&packet);
      return error == AVERROR_EOF ? 0 : error;
    }
    if (packet->stream_index == title->video && (packet->flags & AV_PKT_FLAG_KEY)) {
      av_packet_free(&packet);
      return 0;
    }
    if (!sound_of(title, packet) || packet->pts == AV_NOPTS_VALUE || packet->pos < 0 ||
        (error = push(&title->lead, packet)) < 0)
      av_packet_free(&packet);
    if (error < 0) return error;
  }
  return 0;
}

/** Keeps of the lead what lies before the cluster a seek to the first cut starts at. */
static void prune(TitleHls *title) {
  AVStream *video = title->input->streams[title->video];
  int index = av_index_search_timestamp(video, title->cuts[0], AVSEEK_FLAG_BACKWARD);
  const AVIndexEntry *entry = index >= 0 ? avformat_index_get_entry(video, index) : NULL;
  int kept = 0;
  for (int i = 0; i < title->lead.count; i++) {
    AVPacket *packet = title->lead.items[i];
    if (entry && packet->pos < entry->pos) {
      title->lead.items[kept++] = packet;
    } else {
      title->lead.bytes -= (size_t)packet->size;
      av_packet_free(&packet);
    }
  }
  title->lead.count = kept;
}

static int by_pts(const void *a, const void *b) {
  int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
  return (x > y) - (x < y);
}

/**
 * Gives the segment's pictures their decode times and lengths: their presentation times sorted,
 * less the reorder delay, ending at the next cut, from title time 0, in the picture's base.
 */
static int stamp_pictures(const TitleHls *title, int index, Packets *pictures) {
  int64_t origin = title->cuts[0];
  int64_t *order = av_malloc_array(pictures->count ? pictures->count : 1, sizeof(*order));
  if (!order) return AVERROR(ENOMEM);
  for (int i = 0; i < pictures->count; i++) order[i] = pictures->items[i]->pts;
  qsort(order, pictures->count, sizeof(*order), by_pts);
  // How far the sorted times run ahead of the packets' own: the segment's reorder delay.
  int64_t delay = 0;
  for (int i = 0; i < pictures->count; i++) {
    if (order[i] - pictures->items[i]->pts > delay) delay = order[i] - pictures->items[i]->pts;
  }
  for (int i = 0; i < pictures->count; i++) {
    AVPacket *packet = pictures->items[i];
    int64_t following = i + 1 < pictures->count ? order[i + 1] : title->cuts[index + 1];
    packet->dts = order[i] - delay - origin;
    packet->duration = following - order[i];
    packet->pts -= origin;
  }
  av_free(order);
  return 0;
}

/** Gives a segment's sound its times in `sound_base`; on a frame grid, each one frame long. */
static void stamp_sound(const TitleHls *title, const Sound *sound, Packets *packets) {
  for (int i = 0; i < packets->count; i++) {
    AVPacket *packet = packets->items[i];
    int64_t at = sound_time(title, sound, packet);
    packet->duration = sound->frame ? sound->frame
                                    : av_rescale_q(packet->duration, sound->base, sound_base(sound));
    packet->pts = packet->dts = at;
  }
}

static void forget(Made *made) {
  for (int i = 0; i < 1 + SOUNDS_MOST; i++) av_freep(&made->renditions[i].data);
  memset(made, 0, sizeof(*made));
  made->index = -1;
}

/** Makes every rendition of segment `index` into a kept slot. */
static TitleHlsResult make(TitleHls *title, int index, Made **out, char *detail,
                           size_t detail_size) {
  if (atomic_load(&title->interrupted)) return TITLE_HLS_INTERRUPTED;
  int error = 0;
  if (title->next != index) {
    title->next = -1;
    if ((error = recall_before(title, index)) < 0 || (error = reach(title, index, &title->ahead)) < 0) {
      say(detail, detail_size, "The file couldn't be read at this point.");
      return failure(title, error);
    }
  }
  title->next = -1;
  int64_t start = title->cuts[index], end = title->cuts[index + 1];
  int64_t late = llrint(LATE_SOUND_S / av_q2d(title->video_base));
  int last = index == title->count - 1;
  Packets pictures = {0}, later = {0}, sound[SOUNDS_MOST] = {{0}};
  Packets ahead = title->ahead;
  title->ahead = (Packets){0};
  int at = 0;
  int picture_started = 0, picture_done = 0, sounds_left = title->sound_count;
  int sound_done[SOUNDS_MOST] = {0};
  size_t bytes = 0;
  TitleHlsResult result = TITLE_HLS_OK;
  while (!(picture_done && sounds_left == 0)) {
    AVPacket *packet = NULL;
    error = next_packet(title, &ahead, &at, &packet);
    if (error == AVERROR_EOF) break;
    if (error < 0) {
      result = failure(title, error);
      say(detail, detail_size, "The file couldn't be read at this point.");
      goto end;
    }
    Packets *into = NULL;
    Sound *track = sound_of(title, packet);
    if (packet->pts == AV_NOPTS_VALUE) {
      into = NULL;
    } else if (packet->stream_index == title->video) {
      int key = packet->flags & AV_PKT_FLAG_KEY;
      if (!picture_started) {
        // A seek can land before the cut's keyframe; nothing before it belongs here.
        if (key && packet->pts == start) picture_started = 1;
        else if (key && packet->pts > start) {
          result = TITLE_HLS_UNSUPPORTED;
          say(detail, detail_size, "The file's index names a keyframe it doesn't have.");
          av_packet_free(&packet);
          goto end;
        }
      } else if (!picture_done && !last && key && packet->pts >= end) {
        if (packet->pts > end) {
          result = TITLE_HLS_UNSUPPORTED;
          say(detail, detail_size, "The file's index names a keyframe it doesn't have.");
          av_packet_free(&packet);
          goto end;
        }
        picture_done = 1;
      }
      // Sound not heard of by now has nothing in this segment.
      if (picture_done && packet->pts - end >= late) {
        for (int t = 0; t < title->sound_count; t++) {
          if (!sound_done[t]) {
            sound_done[t] = 1;
            sounds_left--;
          }
        }
      }
      into = !picture_started ? NULL : picture_done ? &later : &pictures;
    } else if (track) {
      int t = (int)(track - title->sounds);
      if (sound_before(title, track, packet, start)) into = NULL;
      else if (last || sound_before(title, track, packet, end)) into = &sound[t];
      else {
        into = &later;
        if (!sound_done[t]) {
          sound_done[t] = 1;
          sounds_left--;
        }
      }
    }
    if (!into) {
      av_packet_free(&packet);
      continue;
    }
    if ((error = push(into, packet)) < 0) {
      av_packet_free(&packet);
      result = TITLE_HLS_NO_MEMORY;
      goto end;
    }
    if (into != &later) bytes += packet->size;
    if (bytes > SEGMENT_BYTES_MOST) {
      result = TITLE_HLS_UNSUPPORTED;
      say(detail, detail_size, "A stretch of the file is too large to play from memory.");
      goto end;
    }
    if (later.count > AHEAD_PACKETS_MOST) {
      result = TITLE_HLS_UNSUPPORTED;
      say(detail, detail_size, "The file's sound lies too far from its picture.");
      goto end;
    }
  }
  if (!picture_started) {
    result = TITLE_HLS_UNSUPPORTED;
    say(detail, detail_size, "The file's index names a keyframe it doesn't have.");
    goto end;
  }
  // The rest of what was read ahead follows what this segment read past its end.
  for (; at < ahead.count; at++) {
    if ((error = push(&later, ahead.items[at])) < 0) {
      result = TITLE_HLS_NO_MEMORY;
      goto end;
    }
    ahead.items[at] = NULL;
  }
  Made *slot = &title->kept[title->kept_next];
  title->kept_next = (title->kept_next + 1) % KEPT;
  forget(slot);
  AVStream *video = title->input->streams[title->video];
  if ((error = stamp_pictures(title, index, &pictures)) < 0 ||
      (error = mux(video, title->video_base, 0, &pictures, NULL, index, &slot->renditions[0])) < 0) {
    forget(slot);
    result = failure(title, error);
    say(detail, detail_size, "This part of the file can't be written as MP4.");
    goto end;
  }
  for (int t = 0; t < title->sound_count; t++) {
    Sound *track = &title->sounds[t];
    stamp_sound(title, track, &sound[t]);
    int gap = fill(title, track, &sound[t], start, end, &bytes);
    if (bytes > SEGMENT_BYTES_MOST) {
      forget(slot);
      result = TITLE_HLS_UNSUPPORTED;
      say(detail, detail_size, "A stretch of the file is too large to play from memory.");
      goto end;
    }
    // A rendition left empty is refused when asked for: a gap it can't be played through.
    if (gap == 1 || sound[t].count == 0) error = 0;
    else if (gap < 0) error = gap;
    else if (packed(title, track)) error = pack(track, &sound[t], &slot->renditions[1 + t]);
    else
      error = mux(title->input->streams[track->stream], sound_base(track), track->frame, &sound[t],
                  NULL, index, &slot->renditions[1 + t]);
    if (error < 0) {
      forget(slot);
      result = failure(title, error);
      say(detail, detail_size, "This part of the file can't be written as MP4.");
      goto end;
    }
  }
  slot->index = index;
  title->passed[index / 8] |= (uint8_t)(1 << (index % 8));
  *out = slot;
  title->ahead = later;
  later = (Packets){0};
  title->next = last ? -1 : index + 1;
end:
  for (int i = at; i < ahead.count; i++) av_packet_free(&ahead.items[i]);
  ahead.count = 0;
  release(&ahead);
  release(&pictures);
  release(&later);
  for (int t = 0; t < SOUNDS_MOST; t++) release(&sound[t]);
  return result;
}

/**
 * Reaches segment `index` as a seek would, then takes the first keyframe and each offered sound
 * track's first packet read: these write the initialization segments, and the first sound
 * packets anchor the grids. What was read is the start of the first segment played, kept for
 * it. A track with no packet there isn't offered.
 */
static int sample(TitleHls *title, int index) {
  int error = reach(title, index, &title->ahead);
  if (error < 0) return error;
  for (int i = 0;; i++) {
    AVPacket *packet = NULL;
    if (i < title->ahead.count) {
      packet = title->ahead.items[i];
    } else {
      // Read on only for the picture, which the sound may have come well before.
      if (title->video_sample || title->ahead.count >= AHEAD_PACKETS_MOST) break;
      if (!(packet = av_packet_alloc())) return AVERROR(ENOMEM);
      if ((error = read_frame(title, packet)) < 0 ||
          (error = push(&title->ahead, packet)) < 0) {
        av_packet_free(&packet);
        if (error == AVERROR_EOF) break;
        return error;
      }
    }
    if (packet->pts == AV_NOPTS_VALUE) continue;
    Sound *sound = sound_of(title, packet);
    if (packet->stream_index == title->video && !title->video_sample &&
        (packet->flags & AV_PKT_FLAG_KEY)) {
      if (!(title->video_sample = av_packet_clone(packet))) return AVERROR(ENOMEM);
    } else if (sound && !sound->sample) {
      if (!(sound->sample = av_packet_clone(packet))) return AVERROR(ENOMEM);
      sound->first = packet->pts;
      sound->frame = sample_frame(title->input->streams[sound->stream]->codecpar, packet);
    }
  }
  int kept = 0;
  for (int i = 0; i < title->sound_count; i++) {
    if (title->sounds[i].sample) title->sounds[kept++] = title->sounds[i];
    else title->input->streams[title->sounds[i].stream]->discard = AVDISCARD_ALL;
  }
  for (int i = kept; i < SOUNDS_MOST; i++) memset(&title->sounds[i], 0, sizeof(title->sounds[i]));
  title->sound_count = kept;
  title->next = index;
  return title->video_sample ? 0 : AVERROR_INVALIDDATA;
}

/** Picks the picture and the sound tracks to offer; the rest isn't read. */
static TitleHlsResult choose(TitleHls *title, char *detail, size_t detail_size) {
  title->video = av_find_best_stream(title->input, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
  if (title->video < 0) {
    say(detail, detail_size, "The file has no picture.");
    return TITLE_HLS_UNSUPPORTED;
  }
  AVStream *video = title->input->streams[title->video];
  enum AVCodecID codec = video->codecpar->codec_id;
  if (codec != AV_CODEC_ID_H264 && codec != AV_CODEC_ID_HEVC) {
    say(detail, detail_size, "Its picture isn't H.264 or HEVC.");
    return TITLE_HLS_UNSUPPORTED;
  }
  title->video_base = video->time_base;
  int64_t *numbers = av_malloc_array(title->input->nb_streams + 1, sizeof(*numbers));
  int *encoded = av_calloc(title->input->nb_streams + 1, sizeof(*encoded));
  if (!numbers || !encoded) {
    av_free(numbers);
    av_free(encoded);
    return TITLE_HLS_NO_MEMORY;
  }
  // Without the Tracks, a text track's encoding isn't known: it isn't served.
  if (!read_head(title, numbers, encoded)) {
    for (unsigned i = 0; i < title->input->nb_streams; i++) encoded[i] = 2;
  }
  int any = 0;
  for (unsigned i = 0; i < title->input->nb_streams; i++) {
    AVStream *st = title->input->streams[i];
    int offered = 0;
    if (st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      any = 1;
      if (sound_playable(st->codecpar) && st->codecpar->sample_rate > 0 &&
          title->sound_count < SOUNDS_MOST) {
        Sound *sound = &title->sounds[title->sound_count++];
        sound->stream = (int)i;
        sound->base = st->time_base;
        sound->rate = st->codecpar->sample_rate;
        sound->frame = sample_frame(st->codecpar, NULL);
        offered = 1;
      }
    } else if (st->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
      if (text_codec(st->codecpar->codec_id) && !encoded[i] && title->text_count < TEXTS_MOST) {
        Text *text = &title->texts[title->text_count++];
        text->stream = (int)i;
        text->number = numbers[i];
        text->base = st->time_base;
        text->forced = !!(st->disposition & AV_DISPOSITION_FORCED);
        offered = 1;
      } else if (title->unshown_count < UNSHOWN_MOST) {
        title->unshown_encoded[title->unshown_count] = text_codec(st->codecpar->codec_id) ? encoded[i] : 0;
        title->unshown[title->unshown_count++] = (int)i;
      } else {
        title->unshown_more++;
      }
    }
    if ((int)i != title->video && !offered) st->discard = AVDISCARD_ALL;
  }
  av_free(numbers);
  av_free(encoded);
  av_freep(&title->head);
  if (any && title->sound_count == 0) {
    say(detail, detail_size, "Its sound isn't AAC-LC, HE-AAC, AC-3, E-AC-3 or MP3.");
    return TITLE_HLS_UNSUPPORTED;
  }
  return TITLE_HLS_OK;
}

TitleHlsResult title_hls_open(const TitleHlsSource *source, double start, TitleHls **out,
                              char *detail, size_t detail_size) {
  *out = NULL;
  TitleHls *title = av_mallocz(sizeof(*title));
  if (!title) return TITLE_HLS_NO_MEMORY;
  title->source = *source;
  title->next = -1;
  title->budget = -1;
  title->cues = -1;
  for (int i = 0; i < KEPT; i++) title->kept[i].index = -1;
  atomic_init(&title->interrupted, 0);
  TitleHlsResult result = TITLE_HLS_NO_MEMORY;
  int error = 0;
  uint8_t *buffer = av_malloc(IO_BUFFER);
  title->input = avformat_alloc_context();
  title->head = av_malloc(HEAD_BYTES);
  if (!buffer || !title->input || !title->head) goto fail;
  title->input->pb = avio_alloc_context(buffer, IO_BUFFER, 0, title, read_packet, NULL, seek);
  if (!title->input->pb) goto fail;
  title->io = title->input->pb;
  buffer = NULL;
  title->input->interrupt_callback = (AVIOInterruptCB){interrupted, title};
  title->input->flags |= AVFMT_FLAG_CUSTOM_IO;
  error = avformat_open_input(&title->input, NULL, NULL, NULL);
  if (error == AVERROR_INVALIDDATA && !atomic_load(&title->interrupted)) {
    // Not Matroska or MP4 after all: AVPlayer gets to try it, as it always did.
    result = TITLE_HLS_DIRECT;
    goto fail;
  }
  if (error < 0) {
    result = failure(title, error);
    say(detail, detail_size, "The file isn't in a format this reads.");
    goto fail;
  }
  if (strstr(title->input->iformat->name, "mov")) {
    result = TITLE_HLS_DIRECT;
    goto fail;
  }
  if ((result = choose(title, detail, detail_size)) != TITLE_HLS_OK) goto fail;
  if ((error = read_lead(title)) < 0) {
    result = failure(title, error);
    say(detail, detail_size, "The file couldn't be read at its start.");
    goto fail;
  }
  // Matroska reads its index on the first seek.
  title->budget = INDEX_BYTES_MOST;
  error = av_seek_frame(title->input, title->video, 0, AVSEEK_FLAG_BACKWARD);
  int over = title->budget == 0;
  title->budget = -1;
  if (over) {
    result = TITLE_HLS_UNSUPPORTED;
    say(detail, detail_size, "The file lists no keyframes to cut at.");
    goto fail;
  }
  if (error < 0 && (result = failure(title, error)) != TITLE_HLS_UNSUPPORTED) goto fail;
  if ((result = plan(title, detail, detail_size)) != TITLE_HLS_OK) goto fail;
  prune(title);
  double length = seconds(title->cuts[title->count] - title->cuts[0], title->video_base);
  title->start = start > 0 && start < length ? start : 0;
  if ((error = sample(title, segment_at(title, title->start))) < 0) {
    result = failure(title, error);
    say(detail, detail_size, "The file couldn't be read where it starts playing.");
    goto fail;
  }
  AVStream *video = title->input->streams[title->video];
  if ((error = mux(video, title->video_base, 0, NULL, title->video_sample, 0,
                   &title->video_init)) < 0)
    goto unwritable;
  for (int t = 0; t < title->sound_count; t++) {
    Sound *sound = &title->sounds[t];
    AVStream *st = title->input->streams[sound->stream];
    if ((!packed(title, sound) &&
         (error = mux(st, sound_base(sound), sound->frame, NULL, sound->sample, 0, &sound->init)) <
             0) ||
        (error = silence_of(st->codecpar, sound->sample, &sound->silence)) < 0)
      goto unwritable;
  }
  *out = title;
  return TITLE_HLS_OK;
unwritable:
  result = failure(title, error);
  say(detail, detail_size, "The file's tracks can't be written as MP4.");
fail:
  av_free(buffer);
  title_hls_close(title);
  return result;
}

/** The CODECS attribute's entry for a track, or NULL when it can't be told. */
static const char *codec_name(const AVCodecParameters *par, char *out, size_t size) {
  const uint8_t *x = par->extradata;
  switch (par->codec_id) {
    case AV_CODEC_ID_H264:
      if (par->extradata_size < 4 || x[0] != 1) return NULL;
      snprintf(out, size, "avc1.%02X%02X%02X", x[1], x[2], x[3]);
      return out;
    case AV_CODEC_ID_AAC:
      // The audio object type, in the first five bits of the AudioSpecificConfig.
      if (par->extradata_size < 1) return NULL;
      snprintf(out, size, "mp4a.40.%d", x[0] >> 3);
      return out;
    case AV_CODEC_ID_AC3:
      av_strlcpy(out, "ac-3", size);
      return out;
    case AV_CODEC_ID_EAC3:
      av_strlcpy(out, "ec-3", size);
      return out;
    case AV_CODEC_ID_MP3:
      av_strlcpy(out, "mp4a.40.34", size);
      return out;
    default:
      return NULL;
  }
}

/** An attribute value without the characters a quoted string may not hold. */
static void quoted(AVBPrint *text, const char *value) {
  for (const char *c = value; *c; c++) {
    if (*c == ',') av_bprint_chars(text, ' ', 1);
    else if (*c != '"' && *c != '\n' && *c != '\r') av_bprint_chars(text, *c, 1);
  }
}

/**
 * The sound track the master playlist makes the default, which AVPlayer plays when a stream is
 * opened: the file's default, else its first.
 */
static int default_sound(const TitleHls *title) {
  for (int t = 0; t < title->sound_count; t++) {
    if (title->input->streams[title->sounds[t].stream]->disposition & AV_DISPOSITION_DEFAULT)
      return t;
  }
  return 0;
}

static void master(TitleHls *title, AVBPrint *text) {
  av_bprintf(text, "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n");
  if (title->start > 0)
    av_bprintf(text, "#EXT-X-START:TIME-OFFSET=%.3f,PRECISE=YES\n", title->start);
  int chosen = default_sound(title);
  for (int t = 0; t < title->sound_count; t++) {
    const AVStream *st = title->input->streams[title->sounds[t].stream];
    const AVDictionaryEntry *language = av_dict_get(st->metadata, "language", NULL, 0);
    const AVDictionaryEntry *name = av_dict_get(st->metadata, "title", NULL, 0);
    int known = language && *language->value && strcmp(language->value, "und") != 0;
    // Names are unique within the group: the track's own, else its language, and its number.
    av_bprintf(text, "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"");
    if (name && *name->value) quoted(text, name->value);
    else if (known) quoted(text, language->value);
    else av_bprintf(text, "Sound");
    av_bprintf(text, " %d\"", t + 1);
    if (known) {
      av_bprintf(text, ",LANGUAGE=\"");
      quoted(text, language->value);
      av_bprintf(text, "\"");
    }
    av_bprintf(text, ",DEFAULT=%s,AUTOSELECT=YES,CHANNELS=\"%d\",URI=\"a%d.m3u8\"\n",
               t == chosen ? "YES" : "NO", st->codecpar->ch_layout.nb_channels, t);
  }
  // The app chooses subtitles itself; none is the default, and forced lines may be autoselected.
  for (int t = 0; t < title->text_count; t++) {
    const AVStream *st = title->input->streams[title->texts[t].stream];
    const char *language = language_of(st);
    const AVDictionaryEntry *name = av_dict_get(st->metadata, "title", NULL, 0);
    av_bprintf(text, "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"");
    if (name && *name->value) quoted(text, name->value);
    else if (language) quoted(text, language);
    else av_bprintf(text, "Subtitles");
    av_bprintf(text, " %d\"", t + 1);
    if (language) {
      av_bprintf(text, ",LANGUAGE=\"");
      quoted(text, language);
      av_bprintf(text, "\"");
    }
    av_bprintf(text, ",DEFAULT=NO,AUTOSELECT=YES,FORCED=%s,URI=\"s%d.m3u8\"\n",
               title->texts[t].forced ? "YES" : "NO", t);
  }
  const AVStream *video = title->input->streams[title->video];
  double length = seconds(title->cuts[title->count] - title->cuts[0], title->video_base);
  int64_t bandwidth = title->input->bit_rate;
  if (bandwidth <= 0 && title->source.size > 0 && length > 0)
    bandwidth = (int64_t)(title->source.size * 8 / length);
  if (bandwidth <= 0) bandwidth = 1000000;
  av_bprintf(text, "#EXT-X-STREAM-INF:BANDWIDTH=%lld", (long long)bandwidth);
  // Every codec of the variant, or none when one can't be named.
  char names[(1 + SOUNDS_MOST) * 24] = "", one[24];
  int named = codec_name(video->codecpar, one, sizeof(one)) != NULL;
  if (named) av_strlcat(names, one, sizeof(names));
  for (int t = 0; named && t < title->sound_count; t++) {
    const AVCodecParameters *par = title->input->streams[title->sounds[t].stream]->codecpar;
    if (!codec_name(par, one, sizeof(one))) named = 0;
    else if (!strstr(names, one)) {
      av_strlcat(names, ",", sizeof(names));
      av_strlcat(names, one, sizeof(names));
    }
  }
  if (named) av_bprintf(text, ",CODECS=\"%s\"", names);
  if (video->codecpar->width > 0)
    av_bprintf(text, ",RESOLUTION=%dx%d", video->codecpar->width, video->codecpar->height);
  if (title->sound_count) av_bprintf(text, ",AUDIO=\"audio\"");
  if (title->text_count) av_bprintf(text, ",SUBTITLES=\"subs\"");
  av_bprintf(text, "\nv.m3u8\n");
}

/**
 * A rendition's media playlist: "v" for the picture, "a<n>" for a sound track, "s<n>" for a
 * subtitle track. Packed audio and WebVTT have no initialization segment; their segments are
 * .mp3 and .vtt.
 */
static void media(TitleHls *title, const char *rendition, AVBPrint *text) {
  int track = rendition[0] != 'v' ? atoi(rendition + 1) : -1;
  int vtt = rendition[0] == 's';
  int raw = vtt || (track >= 0 && packed(title, &title->sounds[track]));
  double target = 0;
  for (int i = 0; i < title->count; i++) {
    double length = seconds(title->cuts[i + 1] - title->cuts[i], title->video_base);
    if (length > target) target = length;
  }
  av_bprintf(text,
             "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:%d\n#EXT-X-PLAYLIST-TYPE:VOD\n"
             "#EXT-X-INDEPENDENT-SEGMENTS\n",
             (int)ceil(target));
  if (title->start > 0)
    av_bprintf(text, "#EXT-X-START:TIME-OFFSET=%.3f,PRECISE=YES\n", title->start);
  if (!raw) av_bprintf(text, "#EXT-X-MAP:URI=\"%s.mp4\"\n", rendition);
  for (int i = 0; i < title->count; i++) {
    av_bprintf(text, "#EXTINF:%.6f,\n%s%s%d.%s\n",
               seconds(title->cuts[i + 1] - title->cuts[i], title->video_base), rendition,
               track >= 0 ? "-" : "", i, vtt ? "vtt" : raw ? "mp3" : "m4s");
  }
  av_bprintf(text, "#EXT-X-ENDLIST\n");
}

/** Parses "<prefix><n><suffix>" exactly, such as "a2-14.m4s"; -1 when `name` isn't that. */
static int numbered(const char *name, const char *prefix, const char *suffix, const char **rest) {
  size_t length = strlen(prefix);
  if (strncmp(name, prefix, length) != 0) return -1;
  const char *digits = name + length;
  char *after = NULL;
  long value = strtol(digits, &after, 10);
  if (after == digits || value < 0 || value > SEGMENTS_MOST) return -1;
  if (rest) {
    *rest = after;
    return (int)value;
  }
  return strcmp(after, suffix) == 0 ? (int)value : -1;
}

/**
 * Segment `index` of subtitle rendition `track`: the segment's pass is made first unless it was,
 * as for its other renditions, then the lines the index lists for it that no read found are read.
 */
static TitleHlsResult subtitle_segment(TitleHls *title, int track, int index, const uint8_t **data,
                                       size_t *size, const char **type, char *detail,
                                       size_t detail_size) {
  title->texts[track].wanted = 1;
  if (!passed(title, index)) {
    Made *made = NULL;
    TitleHlsResult result = make(title, index, &made, detail, detail_size);
    if (result != TITLE_HLS_OK) return result;
  }
  int budget = RECALLS_MOST;
  int error = recall_for(title, track, index, INT64_MAX, &budget);
  // A line the reads couldn't keep would be missing: each segment says so instead, over the
  // picture, which plays on.
  int overflow = 0;
  for (int t = 0; t < title->text_count; t++) overflow |= folds(title, track, t) && title->texts[t].overflow;
  AVBPrint text;
  av_bprint_init(&text, 0, AV_BPRINT_SIZE_UNLIMITED);
  if (error >= 0 && overflow) {
    av_bprintf(&text, "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n");
    vtt_time(&text, title_ms(title, title->cuts[index], title->video_base));
    av_bprintf(&text, " --> ");
    vtt_time(&text, title_ms(title, title->cuts[index + 1], title->video_base));
    av_bprintf(&text, "\nThese subtitles are too large to show.\n");
  } else if (error >= 0) {
    error = write_vtt(title, track, index, &text);
  }
  if (error >= 0 && !av_bprint_is_complete(&text)) error = AVERROR(ENOMEM);
  av_freep(&title->text);
  if (error >= 0) error = av_bprint_finalize(&text, &title->text);
  else av_bprint_finalize(&text, NULL);
  if (error < 0) {
    say(detail, detail_size, "The file couldn't be read at this point.");
    return failure(title, error);
  }
  *data = (const uint8_t *)title->text;
  *size = strlen(title->text);
  *type = VTT;
  return TITLE_HLS_OK;
}

TitleHlsResult title_hls_get(TitleHls *title, const char *name, const uint8_t **data,
                             size_t *size, const char **type, char *detail, size_t detail_size) {
  *data = NULL;
  *size = 0;
  *type = MP4;
  int track = numbered(name, "a", ".m3u8", NULL);
  int subtitle = numbered(name, "s", ".m3u8", NULL);
  if (subtitle >= title->text_count) subtitle = -1;
  if (strcmp(name, "main.m3u8") == 0 || strcmp(name, "v.m3u8") == 0 ||
      (track >= 0 && track < title->sound_count) || subtitle >= 0) {
    // A playlist: written now, kept until the next request.
    AVBPrint text;
    av_bprint_init(&text, 0, AV_BPRINT_SIZE_UNLIMITED);
    if (name[0] == 'm') master(title, &text);
    else if (name[0] == 'v') media(title, "v", &text);
    else {
      char rendition[16];
      snprintf(rendition, sizeof(rendition), "%c%d", name[0], subtitle >= 0 ? subtitle : track);
      // A chosen subtitle rendition has its lines that a seek wouldn't read found from now on.
      if (subtitle >= 0) title->texts[subtitle].wanted = 1;
      media(title, rendition, &text);
    }
    av_freep(&title->text);
    if (!av_bprint_is_complete(&text) || av_bprint_finalize(&text, &title->text) < 0)
      return TITLE_HLS_NO_MEMORY;
    *data = (const uint8_t *)title->text;
    *size = strlen(title->text);
    *type = MPEGURL;
    return TITLE_HLS_OK;
  }
  if (strcmp(name, "v.mp4") == 0) {
    *data = title->video_init.data;
    *size = title->video_init.size;
    return TITLE_HLS_OK;
  }
  track = numbered(name, "a", ".mp4", NULL);
  if (track >= 0 && track < title->sound_count && !packed(title, &title->sounds[track])) {
    *data = title->sounds[track].init.data;
    *size = title->sounds[track].init.size;
    return TITLE_HLS_OK;
  }
  const char *rest = NULL;
  subtitle = numbered(name, "s", NULL, &rest);
  if (subtitle >= 0 && subtitle < title->text_count && *rest == '-') {
    int index = numbered(rest, "-", ".vtt", NULL);
    if (index < 0 || index >= title->count) return TITLE_HLS_MISSING;
    return subtitle_segment(title, subtitle, index, data, size, type, detail, detail_size);
  }
  int rendition = -1, index = numbered(name, "v", ".m4s", NULL);
  if (index >= 0) rendition = 0;
  track = numbered(name, "a", NULL, &rest);
  if (track >= 0 && track < title->sound_count && *rest == '-') {
    int raw = packed(title, &title->sounds[track]);
    index = numbered(rest, "-", raw ? ".mp3" : ".m4s", NULL);
    if (index >= 0) rendition = 1 + track;
    if (raw) *type = MPEG_AUDIO;
  }
  if (rendition < 0 || index < 0 || index >= title->count) return TITLE_HLS_MISSING;
  Made *made = NULL;
  for (int i = 0; i < KEPT; i++) {
    if (title->kept[i].index == index) made = &title->kept[i];
  }
  if (!made) {
    TitleHlsResult result = make(title, index, &made, detail, detail_size);
    if (result != TITLE_HLS_OK) return result;
  }
  // The session fails with this; Try again opens the title anew, from where it stopped, with the
  // default sound.
  if (!made->renditions[rendition].data) {
    say(detail, detail_size,
        rendition - 1 == default_sound(title)
            ? "Its sound has a gap here that can't be played."
            : "The chosen sound has a gap here that can't be played. Try again goes on from here "
              "with the title's main sound.");
    return TITLE_HLS_UNSUPPORTED;
  }
  *data = made->renditions[rendition].data;
  *size = made->renditions[rendition].size;
  return TITLE_HLS_OK;
}

int title_hls_sound_stream(const TitleHls *title, int track) {
  return track >= 0 && track < title->sound_count ? title->sounds[track].stream : -1;
}

int title_hls_subtitle_streams(const TitleHls *title, int track, int *streams, int most) {
  if (track < 0 || track >= title->text_count || most < 1) return 0;
  int count = 0;
  streams[count++] = title->texts[track].stream;
  for (int t = 0; t < title->text_count && count < most; t++) {
    if (t != track && folds(title, track, t)) streams[count++] = title->texts[t].stream;
  }
  return count;
}

int title_hls_subtitle_listed(const TitleHls *title, int track) {
  if (track < 0 || track >= title->text_count || title->listing == 0) return -1;
  return title->texts[track].listed_count;
}

/** A subtitle format's short name, as viewers know it, or NULL. */
static const char *format_name(enum AVCodecID codec) {
  switch (codec) {
    case AV_CODEC_ID_HDMV_PGS_SUBTITLE:
      return "PGS";
    case AV_CODEC_ID_DVD_SUBTITLE:
      return "DVD";
    case AV_CODEC_ID_DVB_SUBTITLE:
      return "DVB";
    case AV_CODEC_ID_DVB_TELETEXT:
      return "teletext";
    case AV_CODEC_ID_XSUB:
      return "XSUB";
    case AV_CODEC_ID_HDMV_TEXT_SUBTITLE:
      return "HDMV text";
    case AV_CODEC_ID_ARIB_CAPTION:
      return "ARIB";
    case AV_CODEC_ID_NONE:
      return NULL;
    default: {
      const AVCodecDescriptor *descriptor = avcodec_descriptor_get(codec);
      return descriptor ? descriptor->name : NULL;
    }
  }
}

int title_hls_unshown(const TitleHls *title, int index, TitleHlsUnshown *out) {
  if (index < 0 || index >= title->unshown_count) return 0;
  const AVStream *st = title->input->streams[title->unshown[index]];
  out->language = language_of(st);
  int encoded = title->unshown_encoded[index];
  out->format = encoded == 1   ? "compressed text"
                : encoded == 2 ? "text of unknown encoding"
                : encoded == 3 ? "encrypted text"
                               : format_name(st->codecpar->codec_id);
  out->forced = !!(st->disposition & AV_DISPOSITION_FORCED);
  return 1;
}

int title_hls_unshown_more(const TitleHls *title) { return title->unshown_more; }

void title_hls_interrupt(TitleHls *title) { atomic_store(&title->interrupted, 1); }

void title_hls_close(TitleHls *title) {
  if (!title) return;
  release(&title->ahead);
  release(&title->lead);
  for (int i = 0; i < KEPT; i++) forget(&title->kept[i]);
  for (int t = 0; t < SOUNDS_MOST; t++) {
    av_packet_free(&title->sounds[t].sample);
    av_free(title->sounds[t].init.data);
    av_packet_free(&title->sounds[t].silence);
  }
  for (int t = 0; t < TEXTS_MOST; t++) {
    for (int i = 0; i < title->texts[t].count; i++) {
      av_free(title->texts[t].cues[i].text);
      av_free(title->texts[t].cues[i].settings);
    }
    av_free(title->texts[t].cues);
    av_free(title->texts[t].listed);
  }
  av_free(title->passed);
  av_free(title->head);
  av_packet_free(&title->video_sample);
  av_free(title->video_init.data);
  av_free(title->text);
  // The input context is closed first; with custom I/O it leaves the I/O context to its owner.
  avformat_close_input(&title->input);
  if (title->io) {
    av_freep(&title->io->buffer);
    avio_context_free(&title->io);
  }
  av_free(title->cuts);
  av_free(title);
}
