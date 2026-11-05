package app.mrstreamer.player

/** Actual native readers fence destructive download operations, including retired attempts. */
object LocalFiles {
  private val readers = mutableMapOf<String, Int>()
  @Synchronized fun opened(path: String) { readers[path] = (readers[path] ?: 0) + 1 }
  @Synchronized fun closed(path: String) {
    val count = (readers[path] ?: error("reader")) - 1
    if (count == 0) readers.remove(path) else readers[path] = count
  }
  @Synchronized fun <T> unused(path: String, operation: () -> T): T {
    check(path !in readers) { "playing" }
    return operation()
  }
}
