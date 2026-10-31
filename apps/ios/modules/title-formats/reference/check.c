// Checks the title_hls core on this machine, against the FFmpeg that scripts/build-ffmpeg.sh
// builds for `reference`. For one file it opens the stream from `start` seconds, writes every
// playlist, initialization segment and segment, each rendition, made in order, into a folder,
// then makes every segment again in a shuffled order, each after a seek, and fails unless both
// are the same bytes. A sound segment refused for a gap is printed, not saved, and must be
// refused again after the seek. streams.txt says which streams of the file each sound and
// subtitle rendition carries. Each subtitle segment is then asked of a title just opened, as
// after a seek: once with the rendition chosen before the seek, once after, and must hold the
// same lines, unless CHECK_UNCUED says the file's index leaves lines out. It counts the separate
// runs of reading the file asks for, which is how many requests a provider would see, and the
// bytes read before the first segment is ready. With CHECK_FAULTS set, the reads such a subtitle
// segment makes fail from each in turn on, as when the provider drops, and the segment asked
// again, as AVPlayer does, must hold the same lines.
//
//   check <file> <folder> [start-seconds [interrupt-after-reads]]
#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../ios/core/title_hls.h"

typedef struct File {
  FILE *file;
  int64_t next; /* where the last read ended: a read elsewhere is a new request */
  int runs;
  int64_t bytes;
  int reads, interrupt_after, fail_at;
  TitleHls *title;
} File;

static int read_at(void *opaque, int64_t offset, uint8_t *buffer, int size) {
  File *file = opaque;
  file->reads++;
  if (file->interrupt_after && file->reads == file->interrupt_after && file->title)
    title_hls_interrupt(file->title);
  if (file->fail_at && file->reads >= file->fail_at) return -1;
  if (offset != file->next) file->runs++;
  if (fseeko(file->file, offset, SEEK_SET) != 0) return -1;
  size_t read = fread(buffer, 1, (size_t)size, file->file);
  if (read == 0 && ferror(file->file)) return -1;
  file->next = offset + (int64_t)read;
  file->bytes += (int64_t)read;
  return (int)read;
}

static int save(const char *folder, const char *name, const uint8_t *data, size_t size) {
  char path[4096];
  snprintf(path, sizeof(path), "%s/%s", folder, name);
  FILE *out = fopen(path, "wb");
  if (!out || fwrite(data, 1, size, out) != size) return -1;
  return fclose(out);
}

/**
 * Copies one resource. A sound segment refused as unsupported, for a gap it can't be played
 * through, is an empty copy and returns 1, once printed; any other failure returns -1.
 */
static int get(TitleHls *title, const char *name, uint8_t **copy, size_t *size) {
  const uint8_t *data;
  const char *type;
  char detail[256] = "";
  TitleHlsResult result = title_hls_get(title, name, &data, size, &type, detail, sizeof(detail));
  if (result == TITLE_HLS_UNSUPPORTED && name[0] == 'a' && strchr(name, '-')) {
    printf("%s refused: %s\n", name, detail);
    *copy = calloc(1, 1);
    *size = 0;
    return 1;
  }
  if (result != TITLE_HLS_OK) {
    printf("%s result=%d detail=%s\n", name, result, detail);
    return -1;
  }
  *copy = malloc(*size + 1);
  memcpy(*copy, data, *size);
  (*copy)[*size] = 0;
  return 0;
}

/**
 * Asks a title just opened from the start for segment `index` of subtitle rendition `track`
 * after a seek to it: with `chosen`, its playlist first, as when the viewer chose the subtitles
 * before seeking; else the picture's segment first. 1 when it differs from `made`, -1 on
 * failure; `*listed` is how many lines the index lists of the rendition's stream. With `fault`,
 * the segment's reads fail from its `fault`th on, and a segment that failed for it is asked
 * again; `*faulted` says whether it had that many reads.
 */
static int fresh(TitleHlsSource *source, int track, int index, int chosen, const uint8_t *made,
                 size_t made_size, int *listed, int fault, int *faulted) {
  File *file = source->opaque;
  TitleHls *title = NULL;
  char detail[256] = "", name[64], playlist[64];
  TitleHlsResult opened = title_hls_open(source, 0, &title, detail, sizeof(detail));
  if (opened != TITLE_HLS_OK) {
    printf("fresh s%d-%d.vtt open result=%d detail=%s\n", track, index, opened, detail);
    return -1;
  }
  uint8_t *data = NULL;
  size_t size = 0;
  int status = -1;
  snprintf(playlist, sizeof(playlist), "s%d.m3u8", track);
  snprintf(name, sizeof(name), "v%d.m4s", index);
  if (get(title, "main.m3u8", &data, &size) < 0) goto done;
  free(data);
  if (get(title, chosen ? playlist : name, &data, &size) < 0) goto done;
  free(data);
  if (get(title, chosen ? name : playlist, &data, &size) < 0) goto done;
  free(data);
  snprintf(name, sizeof(name), "s%d-%d.vtt", track, index);
  if (fault) {
    file->fail_at = file->reads + fault;
    const uint8_t *served;
    const char *type;
    TitleHlsResult result =
        title_hls_get(title, name, &served, &size, &type, detail, sizeof(detail));
    *faulted = file->reads >= file->fail_at;
    file->fail_at = 0;
    if (result == TITLE_HLS_OK) {
      status = size != made_size || memcmp(served, made, size) != 0;
      goto compared;
    }
    if (result != TITLE_HLS_READ_FAILED) {
      printf("faulted %s result=%d detail=%s\n", name, result, detail);
      goto done;
    }
  }
  if (get(title, name, &data, &size) < 0) goto done;
  status = size != made_size || memcmp(data, made, size) != 0;
  free(data);
compared:
  *listed = title_hls_subtitle_listed(title, track);
done:
  title_hls_close(title);
  return status;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: check <file> <folder> [start-seconds [interrupt-after-reads]]\n");
    return 2;
  }
  File file = {.file = fopen(argv[1], "rb"), .next = 0};
  if (!file.file) return 2;
  fseeko(file.file, 0, SEEK_END);
  TitleHlsSource source = {.opaque = &file, .read_at = read_at, .size = ftello(file.file)};
  double start = argc > 3 ? atof(argv[3]) : 0;
  char detail[256] = "";
  TitleHls *title = NULL;
  TitleHlsResult result = title_hls_open(&source, start, &title, detail, sizeof(detail));
  printf("open start=%.3f result=%d runs=%d bytes=%lld detail=%s\n", start, result, file.runs,
         (long long)file.bytes, detail);
  if (result != TITLE_HLS_OK) return result == TITLE_HLS_DIRECT ? 3 : 1;
  file.title = title;
  TitleHlsUnshown unshown;
  for (int i = 0; title_hls_unshown(title, i, &unshown); i++)
    printf("unshown: %s %s%s\n", unshown.language ? unshown.language : "-",
           unshown.format ? unshown.format : "-", unshown.forced ? " forced" : "");
  if (title_hls_unshown_more(title)) printf("unshown: %d more\n", title_hls_unshown_more(title));
  if (argc > 4) file.interrupt_after = file.reads + atoi(argv[4]);
  uint8_t *data, **made = NULL;
  size_t size, *sizes = NULL;
  int *order = NULL, differ = 0, status = 1;
  // The renditions the master playlist names, and how many segments each has; a packed audio
  // rendition has no initialization segment and .mp3 segments, a subtitle one .vtt segments.
  char renditions[40][16];
  int raw[40] = {0};
  const char *ext[40];
  int count = 0, segments = 0;
  // A failure, such as an interrupted read, still closes the title.
  if (get(title, "main.m3u8", &data, &size) < 0) goto done;
  save(argv[2], "main.m3u8", data, size);
  strcpy(renditions[count++], "v");
  for (char *line = strtok((char *)data, "\n"); line; line = strtok(NULL, "\n")) {
    char *uri = strstr(line, "URI=\"");
    if (uri && count < 40) sscanf(uri + 5, "%15[^.]", renditions[count++]);
  }
  free(data);
  // Which of the file's streams each sound rendition carries, for verify.py.
  char path[4096];
  snprintf(path, sizeof(path), "%s/streams.txt", argv[2]);
  FILE *streams = fopen(path, "w");
  for (int r = 1; streams && r < count; r++) {
    int track = atoi(renditions[r] + 1), carried[40], many = 1;
    if (renditions[r][0] == 's') many = title_hls_subtitle_streams(title, track, carried, 40);
    else carried[0] = title_hls_sound_stream(title, track);
    fprintf(streams, "%s", renditions[r]);
    for (int i = 0; i < many; i++) fprintf(streams, " %d", carried[i]);
    fprintf(streams, "\n");
  }
  if (streams) fclose(streams);
  for (int r = 0; r < count; r++) {
    char name[64];
    snprintf(name, sizeof(name), "%s.m3u8", renditions[r]);
    if (get(title, name, &data, &size) < 0) goto done;
    save(argv[2], name, data, size);
    if (r == 0)
      for (char *at = (char *)data; (at = strstr(at, "#EXTINF")); at++) segments++;
    raw[r] = strstr((char *)data, "#EXT-X-MAP") == NULL;
    ext[r] = renditions[r][0] == 's' ? "vtt" : raw[r] ? "mp3" : "m4s";
    free(data);
    if (raw[r]) continue;
    snprintf(name, sizeof(name), "%s.mp4", renditions[r]);
    if (get(title, name, &data, &size) < 0) goto done;
    save(argv[2], name, data, size);
    free(data);
  }
  int first = 0;
  if (start > 0) {
    // The segment the playlist's start falls in: the first the player asks for.
    if (get(title, "v.m3u8", &data, &size) < 0) goto done;
    double at = 0;
    for (char *line = strtok((char *)data, "\n"); line; line = strtok(NULL, "\n")) {
      double length;
      if (sscanf(line, "#EXTINF:%lf", &length) == 1) {
        if (at + length > start) break;
        at += length;
        first++;
      }
    }
    free(data);
  }
  int runs = file.runs;
  int64_t bytes = file.bytes;
  made = calloc((size_t)(segments * count), sizeof(*made));
  sizes = calloc((size_t)(segments * count), sizeof(*sizes));
  size_t largest = 0;
  for (int n = 0; n < segments; n++) {
    int i = (first + n) % segments;
    for (int r = 0; r < count; r++) {
      char name[64];
      if (r == 0) snprintf(name, sizeof(name), "v%d.m4s", i);
      else snprintf(name, sizeof(name), "%s-%d.%s", renditions[r], i, ext[r]);
      int got = get(title, name, &made[i * count + r], &sizes[i * count + r]);
      if (got < 0) goto done;
      if (got == 0) save(argv[2], name, made[i * count + r], sizes[i * count + r]);
      if (sizes[i * count + r] > largest) largest = sizes[i * count + r];
    }
    if (n == 0)
      printf("first segment %d: %d new runs, %lld more bytes\n", i, file.runs - runs,
             (long long)(file.bytes - bytes));
  }
  printf("in order from %d: %d renditions, %d segments, %d new runs, largest %zu bytes\n", first,
         count, segments, file.runs - runs, largest);
  // Shuffled, deterministically: every segment after a seek, its renditions in another order.
  order = malloc((size_t)segments * sizeof(*order));
  for (int i = 0; i < segments; i++) order[i] = i;
  unsigned seed = 7;
  for (int i = segments - 1; i > 0; i--) {
    seed = seed * 1103515245u + 12345u;
    int j = (int)(seed % (unsigned)(i + 1)), t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  runs = file.runs;
  for (int n = 0; n < segments; n++) {
    int i = order[n];
    for (int k = 0; k < count; k++) {
      int r = (k + n) % count;
      char name[64];
      if (r == 0) snprintf(name, sizeof(name), "v%d.m4s", i);
      else snprintf(name, sizeof(name), "%s-%d.%s", renditions[r], i, ext[r]);
      uint8_t *again;
      if (get(title, name, &again, &size) < 0) goto done;
      // Refused again after a seek is the same answer: both are empty.
      if (size != sizes[i * count + r] || memcmp(again, made[i * count + r], size) != 0) {
        if (differ < 5) printf("%s differs after a seek: %zu vs %zu bytes\n", name, size, sizes[i * count + r]);
        differ++;
      }
      free(again);
    }
  }
  printf("shuffled: %d differ, %d new runs for %d seeks\n", differ, file.runs - runs, segments);
  // A file made with subtitle lines left out of its index, CHECK_UNCUED set, may show them only
  // where a pass reads them: its fresh seeks are counted, not failed.
  int uncued = getenv("CHECK_UNCUED") != NULL, unlisted = 0;
  for (int r = 1; r < count; r++) {
    if (renditions[r][0] != 's') continue;
    int track = atoi(renditions[r] + 1), listed = -1, apart[2] = {0}, many[2] = {0};
    for (int chosen = 1; chosen >= 0; chosen--) {
      for (int i = 0; i < segments; i++) {
        int before = file.runs;
        int got = fresh(&source, track, i, chosen, made[i * count + r], sizes[i * count + r],
                        &listed, 0, NULL);
        if (got < 0) goto done;
        apart[chosen] += got;
        many[chosen] += file.runs - before;
        if (got && apart[chosen] <= 3)
          printf("%s-%d.vtt differs from a fresh seek (%s)\n", renditions[r], i,
                 chosen ? "chosen before" : "chosen after");
      }
    }
    printf("fresh %s: %d and %d of %d segments differ, chosen before and after the seek; %d runs a "
           "title, %d; index lists %d lines\n",
           renditions[r], apart[1], apart[0], segments, many[1] / segments, many[0] / segments,
           listed);
    if (uncued) unlisted += apart[0] + apart[1];
    else differ += apart[0] + apart[1];
  }
  if (uncued) printf("%d fresh seeks differ in a file whose index leaves lines out\n", unlisted);
  if (getenv("CHECK_FAULTS")) {
    int faults = 0, apart = 0;
    for (int r = 1; r < count; r++) {
      if (renditions[r][0] != 's') continue;
      int track = atoi(renditions[r] + 1), listed;
      for (int chosen = 1; chosen >= 0; chosen--) {
        for (int i = 0; i < segments; i++) {
          for (int fault = 1, faulted = 1; faulted; fault++) {
            int got = fresh(&source, track, i, chosen, made[i * count + r], sizes[i * count + r],
                            &listed, fault, &faulted);
            if (got < 0) goto done;
            faults += faulted;
            apart += got;
            if (got && apart <= 3)
              printf("%s-%d.vtt differs after read %d failed (%s)\n", renditions[r], i, fault,
                     chosen ? "chosen before" : "chosen after");
          }
        }
      }
    }
    printf("faults: %d reads failed, %d segments differ when asked again\n", faults, apart);
    differ += apart;
  }
  status = differ ? 1 : 0;
done:
  for (int i = 0; made && i < segments * count; i++) free(made[i]);
  free(made);
  free(sizes);
  free(order);
  title_hls_close(title);
  fclose(file.file);
  return status;
}
