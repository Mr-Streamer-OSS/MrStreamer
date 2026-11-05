package app.mrstreamer.player

import android.net.Uri
import android.os.Handler
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.HttpDataSource
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.ts.TsExtractor
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

/**
 * A progressive HTTP source probes Range on each open at zero with unset requested length.
 * A 400/403 probe refusal retries the original GET once, closing the refused connection first.
 * If the provider answers 200, only TS extraction loses its length: this avoids the duration-tail
 * probe and publishes an unseekable map. The loader keeps the real length and ordinary retry reads;
 * other containers, local files, HLS and providers answering 206 keep their normal extraction.
 */
@UnstableApi
internal class NoRangeTs(private val upstream: HttpDataSource.Factory, private val extractors: ExtractorsFactory) {
  private var ignoredRange = false

  /** Published by TS extraction to the owner on the application thread. */
  @Volatile var confirmedNoRange = false
    private set

  val readers = DataSource.Factory {
    val reader = upstream.createDataSource()
    object : DataSource by reader {
      override fun open(dataSpec: DataSpec): Long {
        val probe = dataSpec.position == 0L && dataSpec.length == C.LENGTH_UNSET.toLong()
        val length = try {
          reader.open(if (probe) dataSpec.withAdditionalHeaders(mapOf("Range" to "bytes=0-")) else dataSpec)
        } catch (cause: HttpDataSource.InvalidResponseCodeException) {
          if (!probe || cause.responseCode !in listOf(400, 403) || Thread.currentThread().isInterrupted) throw cause
          try { reader.close() } catch (cleanup: IOException) {
            cause.addSuppressed(cleanup)
            throw cause
          }
          try { reader.open(dataSpec) } catch (retry: IOException) {
            retry.addSuppressed(cause)
            throw retry
          }
        }
        if (probe) ignoredRange = reader.responseCode == 200
        return length
      }
    }
  }

  val factory = object : ExtractorsFactory by extractors {
    override fun createExtractors(): Array<Extractor> = wrap(extractors.createExtractors())
    override fun createExtractors(uri: Uri, headers: Map<String, List<String>>): Array<Extractor> =
      wrap(extractors.createExtractors(uri, headers))
  }

  private fun wrap(candidates: Array<Extractor>): Array<Extractor> = candidates.map { extractor ->
    if (extractor !is TsExtractor) extractor else object : Extractor by extractor {
      override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
        if (ignoredRange) confirmedNoRange = true
        return extractor.read(
          if (ignoredRange) object : ExtractorInput by input {
            override fun getLength(): Long = C.LENGTH_UNSET.toLong()
          } else input,
          seekPosition,
        )
      }
    }
  }.toTypedArray()
}
