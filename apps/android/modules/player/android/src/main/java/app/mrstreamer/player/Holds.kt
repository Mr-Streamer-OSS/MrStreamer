package app.mrstreamer.player

import android.net.Uri
import android.os.Handler
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * What one attempt holds open: its file, or its connections to the provider. Every reader the
 * attempt's media opens is counted, on whichever loader thread opens it, so once the attempt is
 * retired the owner can say when the last one was closed instead of assuming it.
 */
@UnstableApi
internal class Hold(private val main: Handler, private val onSettled: (closed: Boolean) -> Unit) {
  private val open = AtomicInteger()
  private val settled = AtomicBoolean()
  @Volatile private var retired = false

  fun opened() {
    open.incrementAndGet()
  }

  fun closed() {
    if (open.decrementAndGet() == 0 && retired) settle()
  }

  /** No more of this attempt will play: settles now, or when its last reader closes. */
  fun retire() {
    retired = true
    if (open.get() == 0) settle()
  }

  /** Settles as not closed when a reader is still open: called a while after [retire]. */
  fun timeOut() {
    if (settled.compareAndSet(false, true)) main.post { onSettled(false) }
  }

  private fun settle() {
    if (settled.compareAndSet(false, true)) main.post { onSettled(true) }
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
        counted = true
        opened()
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
