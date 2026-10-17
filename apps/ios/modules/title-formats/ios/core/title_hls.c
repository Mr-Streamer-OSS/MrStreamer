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
//   written as one MP4 per rendition. Made in order, the packets read past a cut are kept for
//   the next segment; made after a seek, the read starts at the cut's cluster, or one cut
//   earlier when sound of this segment may lie before it.
// - A sound track may end before the picture, pause, or start late. Sound is waited for until the
//   picture is LATE_SOUND_S past the cut; a track with nothing in a segment gets a fragment with
//   no samples there rather than failing the picture and the other tracks, and one with nothing
//   near where playing starts isn't offered.
// - Each rendition's MP4 is written by a muxer of its own, fed the packets and flushed twice:
//   with delay_moov the first flush writes the header, which for AC-3 and E-AC-3 the muxer can
//   only write once it has parsed a packet, and the second the fragment. A segment keeps the
//   fragment, the initialization segment the header.
#include "title_hls.h"

#include <libavformat/avformat.h>
#include <libavutil/avstring.h>
#include <libavutil/bprint.h>
#include <libavutil/mathematics.h>
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
/** Sound tracks offered at most. */
#define SOUNDS_MOST 8
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
  Bytes init;
} Sound;

/** Every rendition of one segment. */
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
  Made kept[KEPT];
  int kept_next;
  /** The last playlist asked for. */
  char *text;
};

static const char *const MPEGURL = "application/vnd.apple.mpegurl";
static const char *const MP4 = "video/mp4";

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

/**
 * A fragment with no samples: the muxer writes none for a track with nothing to say, and a
 * rendition needs one per segment. Its decode time `at` is where the segment starts.
 */
static int empty_fragment(int index, int64_t at, Bytes *made) {
  static const size_t SIZE = 92;
  uint8_t *x = av_mallocz(SIZE);
  if (!x) return AVERROR(ENOMEM);
  put32(x, 84), memcpy(x + 4, "moof", 4);
  put32(x + 8, 16), memcpy(x + 12, "mfhd", 4), put32(x + 20, (uint32_t)index + 1);
  put32(x + 24, 60), memcpy(x + 28, "traf", 4);
  // tfhd: default-base-is-moof, track 1, which every rendition's single track is.
  put32(x + 32, 16), memcpy(x + 36, "tfhd", 4), put32(x + 40, 0x020000), put32(x + 44, 1);
  put32(x + 48, 20), memcpy(x + 52, "tfdt", 4), put32(x + 56, 0x01000000);
  put32(x + 60, (uint32_t)((uint64_t)at >> 32)), put32(x + 64, (uint32_t)at);
  put32(x + 68, 16), memcpy(x + 72, "trun", 4), put32(x + 76, 0), put32(x + 80, 0);
  put32(x + 84, 8), memcpy(x + 88, "mdat", 4);
  made->data = x;
  made->size = SIZE;
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
  return TITLE_HLS_OK;
}

/** The segment `at` seconds of the title fall in. */
static int segment_at(const TitleHls *title, double at) {
  int64_t ts = title->cuts[0] + llrint(at / av_q2d(title->video_base));
  int index = 0;
  while (index + 1 < title->count && title->cuts[index + 1] <= ts) index++;
  return index;
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
  int error = av_read_frame(title->input, packet);
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
 * found. What was read on the way stays in `ahead`.
 */
static int reach(TitleHls *title, int index, Packets *ahead) {
  for (int from = index; from >= 0 && from >= index - 1; from--) {
    clear(ahead);
    int error = av_seek_frame(title->input, title->video, title->cuts[from], AVSEEK_FLAG_BACKWARD);
    if (error < 0) return error;
    int seen[SOUNDS_MOST] = {0}, missing = title->sound_count, late = 0;
    int64_t until = title->cuts[index] + llrint(LATE_SOUND_S / av_q2d(title->video_base));
    while (missing > 0 && ahead->count < AHEAD_PACKETS_MOST) {
      AVPacket *packet = av_packet_alloc();
      if (!packet) return AVERROR(ENOMEM);
      error = av_read_frame(title->input, packet);
      if (error < 0) {
        av_packet_free(&packet);
        if (error == AVERROR_EOF) break;
        return error;
      }
      if ((error = push(ahead, packet)) < 0) {
        av_packet_free(&packet);
        return error;
      }
      Sound *sound = sound_of(title, packet);
      if (sound && packet->pts != AV_NOPTS_VALUE && !seen[sound - title->sounds]) {
        seen[sound - title->sounds] = 1;
        missing--;
        if (!sound_before(title, sound, packet, title->cuts[index])) late = 1;
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
    if ((error = reach(title, index, &title->ahead)) < 0) {
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
    if (sound[t].count == 0) {
      int64_t at = av_rescale_q(start - title->cuts[0], title->video_base, sound_base(track));
      error = empty_fragment(index, at, &slot->renditions[1 + t]);
    } else {
      error = mux(title->input->streams[track->stream], sound_base(track), track->frame, &sound[t],
                  NULL, index, &slot->renditions[1 + t]);
    }
    if (error < 0) {
      forget(slot);
      result = failure(title, error);
      say(detail, detail_size, "This part of the file can't be written as MP4.");
      goto end;
    }
  }
  slot->index = index;
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
 * Reads from segment `index`'s cut until the picture and every offered sound track have a
 * packet: these write the initialization segments, and the first sound packets anchor the
 * grids. What was read is the start of the first segment played, kept for it. A track with no
 * packet there isn't offered.
 */
static int sample(TitleHls *title, int index) {
  int error = av_seek_frame(title->input, title->video, title->cuts[index], AVSEEK_FLAG_BACKWARD);
  if (error < 0) return error;
  int missing = 1 + title->sound_count;
  int64_t until = title->cuts[index] + llrint(LATE_SOUND_S / av_q2d(title->video_base));
  while (missing > 0 && title->ahead.count < AHEAD_PACKETS_MOST) {
    AVPacket *packet = av_packet_alloc();
    if (!packet) return AVERROR(ENOMEM);
    error = av_read_frame(title->input, packet);
    if (error < 0) {
      av_packet_free(&packet);
      if (error == AVERROR_EOF) break;
      return error;
    }
    if ((error = push(&title->ahead, packet)) < 0) {
      av_packet_free(&packet);
      return error;
    }
    if (packet->pts == AV_NOPTS_VALUE) continue;
    Sound *sound = sound_of(title, packet);
    if (packet->stream_index == title->video && !title->video_sample &&
        (packet->flags & AV_PKT_FLAG_KEY)) {
      if (!(title->video_sample = av_packet_clone(packet))) return AVERROR(ENOMEM);
      missing--;
    } else if (sound && !sound->sample) {
      if (!(sound->sample = av_packet_clone(packet))) return AVERROR(ENOMEM);
      sound->first = packet->pts;
      sound->frame = sample_frame(title->input->streams[sound->stream]->codecpar, packet);
      missing--;
    }
    if (packet->stream_index == title->video && title->video_sample && packet->pts >= until) break;
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
  int any = 0;
  for (unsigned i = 0; i < title->input->nb_streams; i++) {
    AVStream *st = title->input->streams[i];
    int offered = 0;
    if (st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      any = 1;
      if (sound_copyable(st->codecpar->codec_id) && st->codecpar->sample_rate > 0 &&
          title->sound_count < SOUNDS_MOST) {
        Sound *sound = &title->sounds[title->sound_count++];
        sound->stream = (int)i;
        sound->base = st->time_base;
        sound->rate = st->codecpar->sample_rate;
        sound->frame = sample_frame(st->codecpar, NULL);
        offered = 1;
      }
    }
    if ((int)i != title->video && !offered) st->discard = AVDISCARD_ALL;
  }
  if (any && title->sound_count == 0) {
    say(detail, detail_size, "Its sound isn't AAC, AC-3, E-AC-3 or MP3.");
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
  for (int i = 0; i < KEPT; i++) title->kept[i].index = -1;
  atomic_init(&title->interrupted, 0);
  TitleHlsResult result = TITLE_HLS_NO_MEMORY;
  int error = 0;
  uint8_t *buffer = av_malloc(IO_BUFFER);
  title->input = avformat_alloc_context();
  if (!buffer || !title->input) goto fail;
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
    if ((error = mux(title->input->streams[sound->stream], sound_base(sound), sound->frame, NULL,
                     sound->sample, 0, &sound->init)) < 0)
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

static void master(TitleHls *title, AVBPrint *text) {
  av_bprintf(text, "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n");
  if (title->start > 0)
    av_bprintf(text, "#EXT-X-START:TIME-OFFSET=%.3f,PRECISE=YES\n", title->start);
  int chosen = 0;
  for (int t = 0; t < title->sound_count; t++) {
    if (title->input->streams[title->sounds[t].stream]->disposition & AV_DISPOSITION_DEFAULT) {
      chosen = t;
      break;
    }
  }
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
  av_bprintf(text, "\nv.m3u8\n");
}

/** A rendition's media playlist: "v" for the picture, "a<n>" for a sound track. */
static void media(TitleHls *title, const char *rendition, AVBPrint *text) {
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
  av_bprintf(text, "#EXT-X-MAP:URI=\"%s.mp4\"\n", rendition);
  for (int i = 0; i < title->count; i++) {
    av_bprintf(text, "#EXTINF:%.6f,\n%s%s%d.m4s\n",
               seconds(title->cuts[i + 1] - title->cuts[i], title->video_base), rendition,
               rendition[0] == 'a' ? "-" : "", i);
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

TitleHlsResult title_hls_get(TitleHls *title, const char *name, const uint8_t **data,
                             size_t *size, const char **type, char *detail, size_t detail_size) {
  *data = NULL;
  *size = 0;
  *type = MP4;
  int track = numbered(name, "a", ".m3u8", NULL);
  if (strcmp(name, "main.m3u8") == 0 || strcmp(name, "v.m3u8") == 0 ||
      (track >= 0 && track < title->sound_count)) {
    // A playlist: written now, kept until the next request.
    AVBPrint text;
    av_bprint_init(&text, 0, AV_BPRINT_SIZE_UNLIMITED);
    if (name[0] == 'm') master(title, &text);
    else if (name[0] == 'v') media(title, "v", &text);
    else {
      char rendition[16];
      snprintf(rendition, sizeof(rendition), "a%d", track);
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
  if (track >= 0 && track < title->sound_count) {
    *data = title->sounds[track].init.data;
    *size = title->sounds[track].init.size;
    return TITLE_HLS_OK;
  }
  int rendition = -1, index = numbered(name, "v", ".m4s", NULL);
  if (index >= 0) rendition = 0;
  const char *rest = NULL;
  track = numbered(name, "a", NULL, &rest);
  if (track >= 0 && track < title->sound_count && *rest == '-') {
    index = numbered(rest, "-", ".m4s", NULL);
    if (index >= 0) rendition = 1 + track;
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
  *data = made->renditions[rendition].data;
  *size = made->renditions[rendition].size;
  return TITLE_HLS_OK;
}

void title_hls_interrupt(TitleHls *title) { atomic_store(&title->interrupted, 1); }

void title_hls_close(TitleHls *title) {
  if (!title) return;
  release(&title->ahead);
  for (int i = 0; i < KEPT; i++) forget(&title->kept[i]);
  for (int t = 0; t < SOUNDS_MOST; t++) {
    av_packet_free(&title->sounds[t].sample);
    av_free(title->sounds[t].init.data);
  }
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
