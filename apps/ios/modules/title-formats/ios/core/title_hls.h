// A movie or episode file AVPlayer can't open, such as Matroska, served as a VOD HLS stream it
// can: a complete playlist cut at the keyframes the file's own index lists, and fragmented MP4
// segments made on request from the file's packets, copied unchanged. Nothing is decoded.
//
// The file is read through `TitleHlsSource`, which the app answers from the provider or from a
// downloaded copy. One title is used from one thread at a time; `title_hls_interrupt` may be
// called from any thread, and makes a read in progress, and every later one, fail.
#ifndef TITLE_HLS_H
#define TITLE_HLS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TitleHlsSource {
  void *opaque;
  /** Reads up to `size` bytes at `offset`: the bytes read, 0 at the end, negative on failure. */
  int (*read_at)(void *opaque, int64_t offset, uint8_t *buffer, int size);
  /** The file's size in bytes, or -1 when unknown. */
  int64_t size;
} TitleHlsSource;

typedef enum TitleHlsResult {
  TITLE_HLS_OK = 0,
  /** An MP4 or MOV, whatever its name said: AVPlayer opens it itself. */
  TITLE_HLS_DIRECT,
  /** Not a file this reads, or a track this can't copy: the detail says which. */
  TITLE_HLS_UNSUPPORTED,
  /** The source failed to read; the app knows why. */
  TITLE_HLS_READ_FAILED,
  /** Interrupted on request. */
  TITLE_HLS_INTERRUPTED,
  TITLE_HLS_NO_MEMORY,
} TitleHlsResult;

typedef struct TitleHls TitleHls;

/**
 * Reads the file's header and index and plans its segments. On failure `*out` is NULL and
 * `detail`, when given, says why in a short sentence without any address.
 */
TitleHlsResult title_hls_open(const TitleHlsSource *source, TitleHls **out, char *detail,
                              size_t detail_size);

/** The media playlist, naming "init.mp4" and "s<index>.m4s". Owned by the title. */
const char *title_hls_playlist(const TitleHls *title);
/** The initialization segment. Owned by the title. */
const uint8_t *title_hls_init(const TitleHls *title, size_t *size);
int title_hls_segment_count(const TitleHls *title);

/**
 * Makes segment `index`, continuing the read when it follows the last one made, else seeking.
 * `*data` is freed with `title_hls_free`.
 */
TitleHlsResult title_hls_segment(TitleHls *title, int index, uint8_t **data, size_t *size,
                                 char *detail, size_t detail_size);
void title_hls_free(uint8_t *data);

void title_hls_interrupt(TitleHls *title);
void title_hls_close(TitleHls *title);

#ifdef __cplusplus
}
#endif

#endif
