// Checks the title_hls core on this machine, against the FFmpeg that scripts/build-ffmpeg.sh
// builds for `reference`. For one file it writes the playlist, the initialization segment and
// every segment made in order into a folder, then makes every segment again in a shuffled order,
// each after a seek, and fails unless both are the same bytes. It counts the separate runs of
// reading the file asks for, which is how many requests a provider would see.
//
//   check <file> <folder> [interrupt-after-reads]
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
  int reads, interrupt_after;
  TitleHls *title;
} File;

static int read_at(void *opaque, int64_t offset, uint8_t *buffer, int size) {
  File *file = opaque;
  if (file->interrupt_after && ++file->reads == file->interrupt_after && file->title)
    title_hls_interrupt(file->title);
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

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: check <file> <folder> [interrupt-after-reads]\n");
    return 2;
  }
  File file = {.file = fopen(argv[1], "rb"), .next = 0};
  if (!file.file) return 2;
  fseeko(file.file, 0, SEEK_END);
  TitleHlsSource source = {.opaque = &file, .read_at = read_at, .size = ftello(file.file)};
  char detail[256] = "";
  TitleHls *title = NULL;
  TitleHlsResult result = title_hls_open(&source, &title, detail, sizeof(detail));
  printf("open result=%d runs=%d bytes=%lld detail=%s\n", result, file.runs,
         (long long)file.bytes, detail);
  if (result != TITLE_HLS_OK) return 1;
  file.title = title;
  if (argc > 3) file.interrupt_after = file.reads + atoi(argv[3]);
  const char *playlist = title_hls_playlist(title);
  save(argv[2], "list.m3u8", (const uint8_t *)playlist, strlen(playlist));
  size_t init_size;
  const uint8_t *init = title_hls_init(title, &init_size);
  save(argv[2], "init.mp4", init, init_size);
  int count = title_hls_segment_count(title);
  uint8_t **made = calloc((size_t)count, sizeof(*made));
  size_t *sizes = calloc((size_t)count, sizeof(*sizes));
  size_t largest = 0;
  int runs = file.runs;
  for (int i = 0; i < count; i++) {
    result = title_hls_segment(title, i, &made[i], &sizes[i], detail, sizeof(detail));
    if (result != TITLE_HLS_OK) {
      printf("segment %d result=%d detail=%s\n", i, result, detail);
      return 1;
    }
    char name[32];
    snprintf(name, sizeof(name), "s%d.m4s", i);
    save(argv[2], name, made[i], sizes[i]);
    if (sizes[i] > largest) largest = sizes[i];
  }
  printf("in order: %d segments, %d new runs, largest %zu bytes\n", count, file.runs - runs,
         largest);
  // Shuffled, deterministically: every segment after a seek.
  int *order = malloc((size_t)count * sizeof(*order));
  for (int i = 0; i < count; i++) order[i] = i;
  unsigned seed = 7;
  for (int i = count - 1; i > 0; i--) {
    seed = seed * 1103515245u + 12345u;
    int j = (int)(seed % (unsigned)(i + 1)), t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  int differ = 0;
  runs = file.runs;
  for (int n = 0; n < count; n++) {
    int i = order[n];
    uint8_t *again = NULL;
    size_t size = 0;
    result = title_hls_segment(title, i, &again, &size, detail, sizeof(detail));
    if (result != TITLE_HLS_OK) {
      printf("shuffled segment %d result=%d detail=%s\n", i, result, detail);
      return 1;
    }
    if (size != sizes[i] || memcmp(again, made[i], size) != 0) {
      if (differ < 5) printf("segment %d differs after a seek: %zu vs %zu bytes\n", i, size, sizes[i]);
      differ++;
    }
    title_hls_free(again);
  }
  printf("shuffled: %d differ, %d new runs for %d seeks\n", differ, file.runs - runs, count);
  for (int i = 0; i < count; i++) title_hls_free(made[i]);
  title_hls_close(title);
  fclose(file.file);
  return differ ? 1 : 0;
}
