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

  /** Readers for the attempt's media, each counted while open. */
  fun factory(upstream: DataSource.Factory) = DataSource.Factory { Counted(upstream.createDataSource()) }

  private inner class Counted(private val upstream: DataSource) : DataSource {
    private var counted = false

    override fun addTransferListener(transferListener: TransferListener) =
      upstream.addTransferListener(transferListener)

    // DataSource's contract calls close() even when open() throws, so a failed open is counted too.
    override fun open(dataSpec: DataSpec): Long {
      if (!counted) {
        if (!opened()) throw IOException("The attempt was released")
        counted = true
      }
      return upstream.open(dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int) = upstream.read(buffer, offset, length)

    override fun getUri(): Uri? = upstream.uri

    override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

    override fun close() {
      try {
        upstream.close()
      } finally {
        if (counted) {
          counted = false
          closed()
        }
      }
    }
  }
}
