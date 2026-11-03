// Public contract: a bounded FLAC read fails a subtitle request, which remains retryable.
// Reuse the file source from the general checker without changing its assertions.
#define main reference_main
#include "check.c"
#undef main

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  File file = {.file = fopen(argv[1], "rb")};
  if (!file.file) return 2;
  fseeko(file.file, 0, SEEK_END);
  TitleHlsSource source = {.opaque = &file, .read_at = read_at, .size = ftello(file.file)};
  TitleHls *title = NULL;
  char detail[256] = "";
  int status = 1;
  if (title_hls_open(&source, 12, &title, detail, sizeof(detail)) != TITLE_HLS_OK) goto done;
  const uint8_t *data;
  const char *type;
  size_t size;
  for (int attempt = 0; attempt < 2; attempt++) {
    TitleHlsResult result = title_hls_get(title, "s0-1.vtt", &data, &size, &type, detail, sizeof(detail));
    printf("subtitle attempt %d: result=%d detail=%s\n", attempt + 1, result, detail);
    if (result != TITLE_HLS_READ_FAILED ||
        strcmp(detail, "Its FLAC sound has too many invalid frames in a row.")) goto done;
  }
  // Repair only the corrupt frames, keeping timestamps, lengths and indexes identical.
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
  puts("subtitle retry recovered the indexed line");
  status = 0;
done:
  title_hls_close(title);
  if (file.file) fclose(file.file);
  return status;
}
