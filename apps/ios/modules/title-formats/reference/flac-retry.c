// Public contract: failed indexed subtitle recalls remain retryable and recover complete text.
// Reuse the general checker's file source without changing its assertions.
#define main reference_main
#include "check.c"
#undef main

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  File file = {.file = fopen(argv[2], "rb")};
  if (!file.file) return 2;
  fseeko(file.file, 0, SEEK_END);
  TitleHlsSource source = {.opaque = &file, .read_at = read_at, .size = ftello(file.file)};
  TitleHls *title = NULL;
  TitleHls *fresh = NULL;
  char detail[256] = "";
  int status = 1;
  uint8_t *recovered = NULL;
  const uint8_t *data;
  const char *type;
  size_t size;
  if (title_hls_open(&source, 12, &title, detail, sizeof(detail)) != TITLE_HLS_OK)
    goto done;
  // Prepare the later segment from good bytes, isolating recall from reach/make failures.
  if (title_hls_get(title, "v1.m4s", &data, &size, &type, detail, sizeof(detail)) != TITLE_HLS_OK)
    goto done;
  fclose(file.file);
  file.file = fopen(argv[1], "rb");
  if (!file.file) goto done;
  for (int attempt = 0; attempt < 2; attempt++) {
    TitleHlsResult result = title_hls_get(title, "s0-1.vtt", &data, &size, &type, detail, sizeof(detail));
    printf("subtitle attempt %d: result=%d detail=%s\n", attempt + 1, result, detail);
    if (result != TITLE_HLS_UNSUPPORTED ||
        strcmp(detail, "Its FLAC sound has too many invalid frames.")) goto done;
  }
  // Repair only the frame bytes, keeping timestamps, lengths and indexes identical.
  fclose(file.file);
  file.file = fopen(argv[2], "rb");
  if (!file.file) goto done;
  if (title_hls_get(title, "s0-1.vtt", &data, &size, &type, detail, sizeof(detail)) != TITLE_HLS_OK)
    goto done;
  const char line[] = "Line behind invalid FLAC";
  int found = 0;
  for (size_t i = 0; i + sizeof(line) - 1 <= size; i++)
    if (!memcmp(data + i, line, sizeof(line) - 1)) found = 1;
  if (!found) goto done;
  size_t recovered_size = size;
  recovered = malloc(size);
  if (!recovered) goto done;
  memcpy(recovered, data, size);
  if (title_hls_open(&source, 12, &fresh, detail, sizeof(detail)) != TITLE_HLS_OK)
    goto done;
  if (title_hls_get(fresh, "s0-1.vtt", &data, &size, &type, detail, sizeof(detail)) != TITLE_HLS_OK)
    goto done;
  if (size != recovered_size || memcmp(recovered, data, size)) goto done;
  printf("repaired subtitle equals fresh complete subtitle: %zu bytes\n", size);
  file.fail_at = file.reads + 1;
  TitleHlsResult result = title_hls_get(title, "v0.m4s", &data, &size, &type, detail, sizeof(detail));
  printf("later unrelated read: result=%d detail=%s\n", result, detail);
  if (result != TITLE_HLS_READ_FAILED ||
      strcmp(detail, "The file couldn't be read at this point.")) goto done;
  status = 0;
done:
  free(recovered);
  title_hls_close(fresh);
  title_hls_close(title);
  if (file.file) fclose(file.file);
  return status;
}
