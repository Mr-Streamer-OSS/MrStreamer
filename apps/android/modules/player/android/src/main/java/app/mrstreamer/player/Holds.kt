package app.mrstreamer.player

import android.net.Uri
import android.os.Handler
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException

/**
 * What one attempt holds open: its file, or its connections to the provider. Every reader the
 * attempt's media opens is counted, on whichever loader thread opens it, so once the attempt is
 * retired the owner can say when the last one was closed instead of assuming it. Once retired, no
 * reader of it opens again, so a release once reported stays true.
 */
@UnstableApi
internal class Hold(private val main: Handler, private val onSettled: (closed: Boolean) -> Unit) {
  private var open = 0
  private var retired = false
  private var settled = false

  /** Counts a reader opening; false once retired, when it mustn't. */
  @Synchronized
  fun opened(): Boolean {
    if (retired) return false
    open++
    return true
  }

  @Synchronized
  fun closed() {
    open--
    if (open == 0 && retired) settle(true)
  }

  /** No more of this attempt will play: settles now, or when its last reader closes. */
  @Synchronized
  fun retire() {
    retired = true
    if (open == 0) settle(true)
  }

  /** Settles as not closed when a reader is still open: called a while after [retire]. */
  @Synchronized
  fun timeOut() = settle(false)

  private fun settle(closed: Boolean) {
    if (settled) return
    settled = true
    main.post { onSettled(closed) }
  }

  /** An address the attempt may not read: see [PlayerOwner.allows]. */
  class Refused : IOException("The player refused an address")

  /** Readers for the attempt's media, each counted while open, opening only what [allowed] takes. */
  fun factory(upstream: DataSource.Factory, allowed: (Uri) -> Boolean) =
    DataSource.Factory { Counted(upstream.createDataSource(), allowed) }

  private inner class Counted(private val upstream: DataSource, private val allowed: (Uri) -> Boolean) :
    DataSource {
    private var counted = false
    private var localPath: String? = null

    override fun addTransferListener(transferListener: TransferListener) =
      upstream.addTransferListener(transferListener)

    // Register before opening upstream; failed opens release their hold even without a later close.
    override fun open(dataSpec: DataSpec): Long =
      if (dataSpec.uri.scheme == "file") synchronized(LocalFiles) { openCounted(dataSpec) }
      else openCounted(dataSpec)

    private fun openCounted(dataSpec: DataSpec): Long {
      if (!allowed(dataSpec.uri)) throw Refused()
      if (!counted) {
        if (!opened()) throw IOException("The attempt was released")
        counted = true
        if (dataSpec.uri.scheme == "file") {
          localPath = dataSpec.uri.path
          localPath?.let { LocalFiles.opened(it) }
        }
      }
      try { return upstream.open(dataSpec) }
      catch (cause: Throwable) {
        try { close() } catch (cleanup: Throwable) { cause.addSuppressed(cleanup) }
        throw cause
      }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int) = upstream.read(buffer, offset, length)

    override fun getUri(): Uri? = upstream.uri

    override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

    override fun close() {
      try {
        upstream.close()
      } finally {
        if (counted) {
          localPath?.let { LocalFiles.closed(it) }
          localPath = null
          counted = false
          closed()
        }
      }
    }
  }
}
