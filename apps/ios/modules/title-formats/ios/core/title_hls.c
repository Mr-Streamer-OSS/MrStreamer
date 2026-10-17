// See title_hls.h. How the timeline is made:
//
// - The cuts are keyframes of the picture the file's index lists. Matroska's demuxer reads its
//   Cues only on the first seek, so opening seeks to the start once and then takes the index as
//   it stands; reading later adds entries that the plan never uses.
// - Title time 0 is the first cut. A segment is about SEGMENT_S long; a gap in the index longer
//   than SEGMENT_MOST_S, or an index that stops short of the end, leaves the file unsupported
//   rather than with a playlist that would be wrong.
// - Matroska stores presentation times only. A segment's packets keep their order, and their
//   decode times are their presentation times sorted, less the segment's reorder delay so none
//   is after its presentation. The muxer writes negative composition offsets and takes that
//   delay off again (its first packet, the cut's keyframe, has the earliest presentation), so
//   the decode timeline of segment k runs exactly from cut k to cut k+1 and the next segment
//   carries on from there, however the segment was reached.
// - Matroska rounds times to its tick, often a millisecond. Sound with a fixed frame length
//   (AAC) is placed on its frame grid from the first sound packet, so frames follow each other
//   without the gaps or overlaps the rounding would leave.
// - A segment has the picture's packets from its cut's keyframe up to the next cut's, and the
//   sound whose time is between the two cuts. Made in order, the packets read past a cut are
//   kept for the next one; made after a seek, the read starts at the cut's cluster, or one cut
//   earlier when sound of this segment may lie before it.
#include "title_hls.h"

#include <libavformat/avformat.h>
#include <libavutil/avstring.h>
#include <libavutil/bprint.h>
#include <libavutil/mathematics.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

/** About how long a segment is: the first cut this long after the last. Seconds. */
#define SEGMENT_S 4.0
/** The longest gap between cuts. A longer one leaves the file unsupported. */
#define SEGMENT_MOST_S 20.0
/** A last segment shorter than this joins the one before it. */
#define LAST_LEAST_S 1.0
/** Segments a playlist lists at most: some 44 hours. */
#define SEGMENTS_MOST 40000
/** The most a segment may hold. It and the packets read ahead are all in memory at once. */
#define SEGMENT_BYTES_MOST (48 * 1024 * 1024)
/** Packets read past a segment's end at most, before giving up on the sound catching up. */
#define AHEAD_PACKETS_MOST 4096
#define IO_BUFFER 65536
/**
 * The most reading the index may take. A file's Cues are a small fraction of it; without them,
 * FFmpeg's seek would read the whole file to find keyframes, so the reading stops here instead.
 */
#define INDEX_BYTES_MOST (16 * 1024 * 1024)

typedef struct Packets {
  AVPacket **items;
  int count, capacity;
  size_t bytes;
} Packets;

struct TitleHls {
  TitleHlsSource source;
  int64_t position;
  /** Bytes reading may still take, or -1 for no limit. */
  int64_t budget;
  atomic_int interrupted;
  AVIOContext *io;
  AVFormatContext *input;
  int video, audio; /* stream indexes; audio -1 without sound */
  AVRational video_base, audio_base;
  /** Cuts in the picture's time base; cuts[count] is the end of the title. */
  int64_t *cuts;
  int count;
  /** The first sound packet's time, in the sound's time base, for the frame grid. */
  int64_t audio_first;
  /** Samples per frame for sound on a frame grid, 0 otherwise; and its sample rate. */
  int audio_frame, audio_rate;
  /** The segment the input continues into without a seek, or -1. */
  int next;
  Packets ahead;
  char *playlist;
  uint8_t *init;
  size_t init_size;
};

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

/**
 * The time base sound is written in: its samples when it is on a frame grid, else its own.
 */
static AVRational sound_base(const TitleHls *title) {
  return title->audio_frame ? (AVRational){1, title->audio_rate} : title->audio_base;
}

/**
 * A sound packet's time from title time 0, in `sound_base`: for sound on a frame grid, the
 * first sound packet's time plus a whole number of frames.
 */
static int64_t sound_time(const TitleHls *title, const AVPacket *packet) {
  AVRational base = sound_base(title);
  int64_t origin = av_rescale_q(title->cuts[0], title->video_base, base);
  if (!title->audio_frame) return av_rescale_q(packet->pts, title->audio_base, base) - origin;
  int64_t first = av_rescale_q(title->audio_first, title->audio_base, base);
  double frames = (double)(av_rescale_q(packet->pts, title->audio_base, base) - first) /
                  title->audio_frame;
  return first + llrint(frames) * title->audio_frame - origin;
}

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

/** Whether a codec is one AVPlayer plays from fragmented MP4, copied as it is. */
static int copyable(enum AVCodecID codec) {
  switch (codec) {
    case AV_CODEC_ID_H264:
    case AV_CODEC_ID_HEVC:
    case AV_CODEC_ID_AAC:
    case AV_CODEC_ID_AC3:
    case AV_CODEC_ID_EAC3:
    case AV_CODEC_ID_MP3:
      return 1;
    default:
      return 0;
  }
}

/** Writes the MP4 for `packets` (NULL: the initialization segment) into `*data`. */
static int mux(TitleHls *title, int index, Packets *packets, uint8_t **data, size_t *size) {
  AVFormatContext *out = NULL;
  AVDictionary *options = NULL;
  AVIOContext *io = NULL;
  uint8_t *bytes = NULL;
  int error = avformat_alloc_output_context2(&out, NULL, "mp4", NULL);
  if (error < 0) return error;
  int streams[2] = {title->video, title->audio};
  for (int i = 0; i < 2 && streams[i] >= 0; i++) {
    AVStream *in = title->input->streams[streams[i]];
    AVStream *st = avformat_new_stream(out, NULL);
    if (!st || (error = avcodec_parameters_copy(st->codecpar, in->codecpar)) < 0) {
      error = error < 0 ? error : AVERROR(ENOMEM);
      goto end;
    }
    st->codecpar->codec_tag = 0;
    if (st->codecpar->codec_id == AV_CODEC_ID_HEVC)
      st->codecpar->codec_tag = MKTAG('h', 'v', 'c', '1');
    st->time_base = i == 0 ? title->video_base : sound_base(title);
    if (i == 1 && title->audio_frame) st->codecpar->frame_size = title->audio_frame;
  }
  out->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
  av_dict_set(&options, "movflags",
              "frag_custom+empty_moov+default_base_moof+negative_cts_offsets+frag_discont", 0);
  av_dict_set(&options, "use_editlist", "0", 0);
  av_dict_set_int(&options, "fragment_index", index + 1, 0);
  if ((error = avio_open_dyn_buf(&io)) < 0) goto end;
  out->pb = io;
  if ((error = avformat_write_header(out, &options)) < 0) goto end;
  if (packets) {
    // The header goes nowhere: the initialization segment, made once, says the same.
    uint8_t *header = NULL;
    avio_close_dyn_buf(io, &header);
    av_free(header);
    io = NULL;
    if ((error = avio_open_dyn_buf(&io)) < 0) goto end;
    out->pb = io;
    for (int i = 0; i < packets->count; i++) {
      AVPacket *packet = packets->items[i];
      packet->stream_index = packet->stream_index == title->video ? 0 : 1;
      av_packet_rescale_ts(packet, packet->stream_index == 0 ? title->video_base : sound_base(title),
                           out->streams[packet->stream_index]->time_base);
      if ((error = av_write_frame(out, packet)) < 0) goto end;
    }
    if ((error = av_write_frame(out, NULL)) < 0) goto end;
  } else if ((error = av_write_frame(out, NULL)) < 0) {
    goto end;
  }
  avio_flush(io);
  int length = avio_close_dyn_buf(io, &bytes);
  io = NULL;
  *data = bytes;
  *size = (size_t)length;
  error = 0;
end:
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

static TitleHlsResult write_playlist(TitleHls *title) {
  double target = 0;
  for (int i = 0; i < title->count; i++) {
    double length = seconds(title->cuts[i + 1] - title->cuts[i], title->video_base);
    if (length > target) target = length;
  }
  AVBPrint text;
  av_bprint_init(&text, 0, AV_BPRINT_SIZE_UNLIMITED);
  av_bprintf(&text,
             "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:%d\n#EXT-X-PLAYLIST-TYPE:VOD\n"
             "#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"init.mp4\"\n",
             (int)ceil(target));
  for (int i = 0; i < title->count; i++) {
    av_bprintf(&text, "#EXTINF:%.6f,\ns%d.m4s\n",
               seconds(title->cuts[i + 1] - title->cuts[i], title->video_base), i);
  }
  av_bprintf(&text, "#EXT-X-ENDLIST\n");
  if (!av_bprint_is_complete(&text)) {
    av_bprint_finalize(&text, NULL);
    return TITLE_HLS_NO_MEMORY;
  }
  return av_bprint_finalize(&text, &title->playlist) < 0 ? TITLE_HLS_NO_MEMORY : TITLE_HLS_OK;
}

TitleHlsResult title_hls_open(const TitleHlsSource *source, TitleHls **out, char *detail,
                              size_t detail_size) {
  *out = NULL;
  TitleHls *title = av_mallocz(sizeof(*title));
  if (!title) return TITLE_HLS_NO_MEMORY;
  title->source = *source;
  title->next = -1;
  title->audio = -1;
  title->budget = -1;
  atomic_init(&title->interrupted, 0);
  TitleHlsResult result = TITLE_HLS_NO_MEMORY;
  uint8_t *buffer = av_malloc(IO_BUFFER);
  title->input = avformat_alloc_context();
  if (!buffer || !title->input) goto fail;
  title->input->pb = avio_alloc_context(buffer, IO_BUFFER, 0, title, read_packet, NULL, seek);
  if (!title->input->pb) goto fail;
  title->io = title->input->pb;
  buffer = NULL;
  title->input->interrupt_callback = (AVIOInterruptCB){interrupted, title};
  title->input->flags |= AVFMT_FLAG_CUSTOM_IO;
  int error = avformat_open_input(&title->input, NULL, NULL, NULL);
  if (error < 0) {
    result = failure(title, error);
    say(detail, detail_size, "The file isn't in a format this reads.");
    goto fail;
  }
  if (strstr(title->input->iformat->name, "mov")) {
    result = TITLE_HLS_DIRECT;
    goto fail;
  }
  title->video = av_find_best_stream(title->input, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
  if (title->video < 0) {
    result = TITLE_HLS_UNSUPPORTED;
    say(detail, detail_size, "The file has no picture.");
    goto fail;
  }
  AVStream *video = title->input->streams[title->video];
  if (!copyable(video->codecpar->codec_id) || video->codecpar->codec_type != AVMEDIA_TYPE_VIDEO) {
    result = TITLE_HLS_UNSUPPORTED;
    say(detail, detail_size, "Its picture isn't H.264 or HEVC.");
    goto fail;
  }
  title->video_base = video->time_base;
  int audio = av_find_best_stream(title->input, AVMEDIA_TYPE_AUDIO, -1, title->video, NULL, 0);
  if (audio >= 0) {
    AVStream *sound = title->input->streams[audio];
    if (!copyable(sound->codecpar->codec_id)) {
      result = TITLE_HLS_UNSUPPORTED;
      say(detail, detail_size, "Its sound isn't AAC, AC-3, E-AC-3 or MP3.");
      goto fail;
    }
    title->audio = audio;
    title->audio_base = sound->time_base;
    if (sound->codecpar->sample_rate > 0) {
      title->audio_frame = frame_samples(sound->codecpar->codec_id);
      title->audio_rate = sound->codecpar->sample_rate;
    }
  }
  for (unsigned i = 0; i < title->input->nb_streams; i++) {
    if ((int)i != title->video && (int)i != title->audio)
      title->input->streams[i]->discard = AVDISCARD_ALL;
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
  if (title->audio >= 0 && title->audio_frame) {
    // The first sound packet anchors the frame grid; what is read on the way is the start of
    // the first segment, kept for it.
    if ((error = av_seek_frame(title->input, title->video, title->cuts[0], AVSEEK_FLAG_BACKWARD)) < 0) {
      result = failure(title, error);
      say(detail, detail_size, "The file couldn't be read from its start.");
      goto fail;
    }
    title->audio_first = AV_NOPTS_VALUE;
    while (title->audio_first == AV_NOPTS_VALUE) {
      AVPacket *packet = av_packet_alloc();
      if (!packet) goto fail;
      error = av_read_frame(title->input, packet);
      if (error < 0) {
        av_packet_free(&packet);
        if (error == AVERROR_EOF) break;
        result = failure(title, error);
        say(detail, detail_size, "The file couldn't be read from its start.");
        goto fail;
      }
      if (packet->stream_index == title->audio && packet->pts != AV_NOPTS_VALUE)
        title->audio_first = packet->pts;
      if (push(&title->ahead, packet) < 0 || title->ahead.count > AHEAD_PACKETS_MOST) {
        av_packet_free(&packet);
        result = TITLE_HLS_UNSUPPORTED;
        say(detail, detail_size, "The file's sound starts too far from its picture.");
        goto fail;
      }
    }
    if (title->audio_first == AV_NOPTS_VALUE) title->audio = -1;
    title->next = 0;
  }
  if ((result = write_playlist(title)) != TITLE_HLS_OK) goto fail;
  if ((error = mux(title, 0, NULL, &title->init, &title->init_size)) < 0) {
    result = failure(title, error);
    say(detail, detail_size, "The file's tracks can't be written as MP4.");
    goto fail;
  }
  *out = title;
  return TITLE_HLS_OK;
fail:
  av_free(buffer);
  title_hls_close(title);
  return result;
}

const char *title_hls_playlist(const TitleHls *title) { return title->playlist; }

const uint8_t *title_hls_init(const TitleHls *title, size_t *size) {
  *size = title->init_size;
  return title->init;
}

int title_hls_segment_count(const TitleHls *title) { return title->count; }

/** Reads the next packet of the two tracks, taking any read ahead first. */
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

static int by_pts(const void *a, const void *b) {
  int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
  return (x > y) - (x < y);
}

/**
 * Gives the segment's packets their decode times and lengths: the picture's presentation times
 * sorted, ending at the next cut, and the sound's place on its grid, all from title time 0.
 */
static int stamp(TitleHls *title, int index, Packets *packets) {
  int64_t origin = title->cuts[0];
  int pictures = 0;
  for (int i = 0; i < packets->count; i++) pictures += packets->items[i]->stream_index == title->video;
  int64_t *order = av_malloc_array(pictures ? pictures : 1, sizeof(*order));
  if (!order) return AVERROR(ENOMEM);
  for (int i = 0, n = 0; i < packets->count; i++) {
    if (packets->items[i]->stream_index == title->video) order[n++] = packets->items[i]->pts;
  }
  qsort(order, pictures, sizeof(*order), by_pts);
  // How far the sorted times run ahead of the packets' own: the segment's reorder delay.
  int64_t delay = 0;
  for (int i = 0, n = 0; i < packets->count; i++) {
    if (packets->items[i]->stream_index != title->video) continue;
    if (order[n] - packets->items[i]->pts > delay) delay = order[n] - packets->items[i]->pts;
    n++;
  }
  AVRational base = sound_base(title);
  int64_t frame = title->audio_frame;
  for (int i = 0, n = 0; i < packets->count; i++) {
    AVPacket *packet = packets->items[i];
    if (packet->stream_index == title->video) {
      int64_t following = n + 1 < pictures ? order[n + 1] : title->cuts[index + 1];
      packet->dts = order[n] - delay - origin;
      packet->duration = following - order[n];
      packet->pts -= origin;
      n++;
    } else {
      // In `sound_base`, which the muxer is told; on the grid, each frame one frame long.
      packet->pts = packet->dts = sound_time(title, packet);
      if (frame) packet->duration = frame;
      else packet->duration = av_rescale_q(packet->duration, title->audio_base, base);
    }
  }
  av_free(order);
  return 0;
}

/** Whether a sound packet's time lies before the cut `at`, on the picture's clock. */
static int sound_before(const TitleHls *title, const AVPacket *packet, int64_t at) {
  return av_compare_ts(sound_time(title, packet), sound_base(title), at - title->cuts[0],
                       title->video_base) < 0;
}

/** Moves the read to segment `index`'s cut, or one earlier when its sound may start before. */
static int reach(TitleHls *title, int index, Packets *ahead) {
  clear(ahead);
  for (int from = index; from >= 0 && from >= index - 1; from--) {
    int error = av_seek_frame(title->input, title->video, title->cuts[from], AVSEEK_FLAG_BACKWARD);
    if (error < 0) return error;
    // Read until the first sound packet: if it is already past the cut, some of this segment's
    // sound may lie before the cluster the seek found, so start one cut earlier.
    int sound_ok = title->audio < 0;
    while (!sound_ok) {
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
      if (ahead->count > AHEAD_PACKETS_MOST) return AVERROR_INVALIDDATA;
      if (packet->stream_index == title->audio) {
        sound_ok = sound_before(title, packet, title->cuts[index]) || from == 0;
        break;
      }
    }
    if (sound_ok || from == index - 1 || from == 0) return 0;
    clear(ahead);
  }
  return 0;
}

TitleHlsResult title_hls_segment(TitleHls *title, int index, uint8_t **data, size_t *size,
                                 char *detail, size_t detail_size) {
  *data = NULL;
  *size = 0;
  if (index < 0 || index >= title->count) {
    say(detail, detail_size, "No such segment.");
    return TITLE_HLS_UNSUPPORTED;
  }
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
  int last = index == title->count - 1;
  Packets segment = {0}, later = {0};
  Packets ahead = title->ahead;
  title->ahead = (Packets){0};
  int at = 0;
  int picture_started = 0, picture_done = 0, sound_done = title->audio < 0;
  TitleHlsResult result = TITLE_HLS_OK;
  while (!(picture_done && sound_done)) {
    AVPacket *packet = NULL;
    error = next_packet(title, &ahead, &at, &packet);
    if (error == AVERROR_EOF) break;
    if (error < 0) {
      result = failure(title, error);
      say(detail, detail_size, "The file couldn't be read at this point.");
      goto end;
    }
    Packets *into = NULL;
    if (packet->stream_index == title->video && packet->pts != AV_NOPTS_VALUE) {
      int key = packet->flags & AV_PKT_FLAG_KEY;
      if (!picture_started) {
        // A seek can land before the cut's keyframe; nothing before it belongs here.
        if (key && packet->pts == start) picture_started = 1;
        else if (packet->pts >= start && key && packet->pts > start) {
          result = TITLE_HLS_UNSUPPORTED;
          say(detail, detail_size, "The file's index names a keyframe it doesn't have.");
          av_packet_free(&packet);
          goto end;
        }
      }
      if (picture_started && !picture_done) {
        if (!last && key && packet->pts == end) picture_done = 1;
        else if (!last && key && packet->pts > end) {
          result = TITLE_HLS_UNSUPPORTED;
          say(detail, detail_size, "The file's index names a keyframe it doesn't have.");
          av_packet_free(&packet);
          goto end;
        }
      }
      into = !picture_started ? NULL : picture_done ? &later : &segment;
    } else if (packet->stream_index == title->audio && packet->pts != AV_NOPTS_VALUE) {
      if (sound_before(title, packet, start)) into = NULL;
      else if (last || sound_before(title, packet, end)) into = &segment;
      else {
        into = &later;
        sound_done = 1;
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
    if (segment.bytes > SEGMENT_BYTES_MOST) {
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
  if ((error = stamp(title, index, &segment)) < 0 ||
      (error = mux(title, index, &segment, data, size)) < 0) {
    result = failure(title, error);
    say(detail, detail_size, "This part of the file can't be written as MP4.");
    goto end;
  }
  title->ahead = later;
  later = (Packets){0};
  title->next = last ? -1 : index + 1;
end:
  for (int i = at; i < ahead.count; i++) av_packet_free(&ahead.items[i]);
  ahead.count = 0;
  release(&ahead);
  release(&segment);
  release(&later);
  return result;
}

void title_hls_free(uint8_t *data) { av_free(data); }

void title_hls_interrupt(TitleHls *title) { atomic_store(&title->interrupted, 1); }

void title_hls_close(TitleHls *title) {
  if (!title) return;
  release(&title->ahead);
  // The input context is closed first; with custom I/O it leaves the I/O context to its owner.
  avformat_close_input(&title->input);
  if (title->io) {
    av_freep(&title->io->buffer);
    avio_context_free(&title->io);
  }
  av_free(title->cuts);
  av_free(title->playlist);
  av_free(title->init);
  av_free(title);
}
