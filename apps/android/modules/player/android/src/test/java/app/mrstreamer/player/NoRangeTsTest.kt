package app.mrstreamer.player

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.TransferListener
import java.util.concurrent.atomic.AtomicLong
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.test.utils.FakeExtractorOutput
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import java.util.Collections
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NoRangeTsTest {
  // Repeat a lawful TS fixture so the duration probe is far beyond the startup read budget.
  private val packetStream = javaClass.classLoader!!.getResourceAsStream("media/hls/segment0.m2ts")!!.use { it.readBytes() }
  private val body = ByteArray(packetStream.size * 2000) { packetStream[it % packetStream.size] }

  @Test fun ignoredRangeStartsWithoutDiscardingTheFileReopensAtItsPositionAndClosesItsHold() =
    withSource(false) { source, url, requests, hold, settled ->
      val output = extract(source, url, 512 * 1024)
      assertTrue("Startup consumed nearly the whole response", transferred.get() < 512 * 1024)
      assertTrue(output.trackOutputs.size() > 0)
      assertFalse(output.seekMap.isSeekable)
      assertEquals(C.TIME_UNSET, output.seekMap.durationUs)
      assertEquals(listOf("bytes=0-"), requests.toList())
      source.close()
      val position = 188L * 10
      assertEquals(body.size - position, source.open(DataSpec.Builder().setUri(url).setPosition(position).build()))
      val bytes = ByteArray(188)
      assertEquals(bytes.size, source.read(bytes, 0, bytes.size))
      assertArrayEquals(body.copyOfRange(position.toInt(), position.toInt() + bytes.size), bytes)
      assertEquals(listOf("bytes=0-", "bytes=$position-"), requests.toList())
      hold.retire()
      ShadowLooper.idleMainLooper()
      assertNull(settled())
      source.close()
      ShadowLooper.idleMainLooper()
      assertEquals(true, settled())
      assertEquals(starts.get(), ends.get())
    }

  @Test fun rangeProviderRetainsDurationAndByteSeeks() = withSource(true) { source, url, requests, _, _ ->
    val output = extract(source, url, body.size * 2)
    assertTrue(output.seekMap.isSeekable)
    assertTrue(output.seekMap.durationUs > 0)
    assertTrue(requests.any { it != "bytes=0-" })
    source.close()
    val position = output.seekMap.getSeekPoints(output.seekMap.durationUs / 2).first.position
    assertTrue(position > 0)
    source.open(DataSpec.Builder().setUri(url).setPosition(position).build())
    val bytes = ByteArray(188)
    assertEquals(bytes.size, source.read(bytes, 0, bytes.size))
    assertArrayEquals(body.copyOfRange(position.toInt(), position.toInt() + bytes.size), bytes)
    assertEquals("bytes=$position-", requests.last())
  }

  @Test fun interruptedRetryPropagatesAndSettlesWithoutCallerClose() =
    withSource(false, interruptRetry = true) { source, url, requests, hold, settled ->
      source.open(DataSpec(url))
      source.close()
      val failure = try {
        assertThrows(androidx.media3.datasource.HttpDataSource.HttpDataSourceException::class.java) {
          source.open(DataSpec.Builder().setUri(url).setPosition(1880).build())
        }
      } finally { Thread.interrupted() }
      assertTrue(failure.cause is java.io.InterruptedIOException)
      assertEquals(listOf("bytes=0-", "bytes=1880-"), requests.toList())
      assertEquals(2L, starts.get())
      hold.retire()
      ShadowLooper.idleMainLooper()
      assertEquals(true, settled())
      assertEquals(starts.get(), ends.get())
      source.close()
      source.close()
      assertEquals(starts.get(), ends.get())
    }

  @Test fun rangeRejectingProviderStillServesLinearMedia() =
    withSource(false, rejectRange = 403) { source, url, requests, _, _ ->
      assertEquals(body.size.toLong(), source.open(DataSpec(url)))
      val bytes = ByteArray(188)
      assertEquals(bytes.size, source.read(bytes, 0, bytes.size))
      assertArrayEquals(body.copyOfRange(0, bytes.size), bytes)
      assertEquals(listOf("bytes=0-", "none"), requests.toList())
      source.close()
      assertEquals(1L, starts.get())
      assertEquals(starts.get(), ends.get())
    }

  @Test fun badRequestRangeProbeFallsBackOnce() =
    withSource(false, rejectRange = 400) { source, url, requests, _, _ ->
      assertEquals(body.size.toLong(), source.open(DataSpec(url)))
      assertEquals(listOf("bytes=0-", "none"), requests.toList())
    }

  @Test fun failedPlainGetSurfacesActualErrorAndSettlesWithoutCallerClose() =
    withSource(false, rejectRange = 403, plainStatus = 401) { source, url, requests, hold, settled ->
      val failure = assertThrows(androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException::class.java) {
        source.open(DataSpec(url))
      }
      assertEquals(401, failure.responseCode)
      assertEquals(403, (failure.suppressed.single() as androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException).responseCode)
      assertEquals(listOf("bytes=0-", "none"), requests.toList())
      hold.retire()
      ShadowLooper.idleMainLooper()
      assertEquals(true, settled())
      assertEquals(starts.get(), ends.get())
      source.close()
    }

  @Test fun cancellationDuringPlainGetRemainsTheActualCauseAndSettles() =
    withSource(false, rejectRange = 403, cancelPlain = true) { source, url, requests, hold, settled ->
      val failure = try {
        assertThrows(java.io.InterruptedIOException::class.java) { source.open(DataSpec(url)) }.also {
          assertTrue(Thread.currentThread().isInterrupted)
        }
      } finally { Thread.interrupted() }
      assertEquals(403, (failure.suppressed.single() as androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException).responseCode)
      assertEquals(listOf("bytes=0-", "none"), requests.toList())
      hold.retire()
      ShadowLooper.idleMainLooper()
      assertEquals(true, settled())
      assertEquals(starts.get(), ends.get())
      source.close()
    }

  @Test fun missingResourceDoesNotTriggerFallback() =
    withSource(false, rejectRange = 404) { source, url, requests, hold, settled ->
      val failure = assertThrows(androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException::class.java) {
        source.open(DataSpec(url))
      }
      assertEquals(404, failure.responseCode)
      assertEquals(listOf("bytes=0-"), requests.toList())
      hold.retire()
      ShadowLooper.idleMainLooper()
      assertEquals(true, settled())
    }

  private val transferred = AtomicLong()
  private val starts = AtomicLong()
  private val ends = AtomicLong()
  private lateinit var extractorFactory: ExtractorsFactory

  private fun extract(source: DataSource, url: Uri, budget: Int): FakeExtractorOutput {
    var read = 0
    val counted = object : DataSource by source {
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        assertTrue("Extraction discarded more than $budget bytes before outputting samples", read < budget)
        return source.read(buffer, offset, length.coerceAtMost(budget - read)).also { if (it > 0) read += it }
      }
    }
    val length = source.open(DataSpec(url))
    val candidates = extractorFactory.createExtractors(url, source.responseHeaders)
    var input = DefaultExtractorInput(counted, 0, length)
    val extractor = candidates.first { candidate ->
      try { candidate.sniff(input) } finally { input.resetPeekPosition() }
    }
    val output = FakeExtractorOutput()
    extractor.init(output)
    val seek = PositionHolder()
    try {
      while ((0 until output.trackOutputs.size()).none { output.trackOutputs.valueAt(it).sampleCount > 0 }) {
        when (extractor.read(input, seek)) {
          Extractor.RESULT_END_OF_INPUT -> fail("No samples extracted")
          Extractor.RESULT_SEEK -> {
            source.close()
            val remaining = source.open(DataSpec.Builder().setUri(url).setPosition(seek.position).build())
            input = DefaultExtractorInput(counted, seek.position, seek.position + remaining)
          }
        }
      }
      assertNotNull(output.seekMap)
      return output
    } finally { extractor.release() }
  }

  private fun withSource(ranges: Boolean, interruptRetry: Boolean = false, rejectRange: Int? = null, plainStatus: Int? = null, cancelPlain: Boolean = false, test: (DataSource, Uri, MutableList<String>, Hold, () -> Boolean?) -> Unit) {
    val requests = Collections.synchronizedList(mutableListOf<String>())
    val server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        val range = request.getHeader("Range")
        requests += range ?: "none"
        if (range != null && rejectRange != null) return MockResponse().setResponseCode(rejectRange)
        if (range == null && plainStatus != null) return MockResponse().setResponseCode(plainStatus)
        val start = if (ranges && range != null) range.substringAfter("bytes=").substringBefore('-').toInt() else 0
        val response = MockResponse().setBody(Buffer().write(body, start, body.size - start))
        if (ranges && range != null) {
          response.setResponseCode(206).addHeader("Content-Range", "bytes $start-${body.lastIndex}/${body.size}")
        }
        return response
      }
    }
    server.start()
    val http = DefaultHttpDataSource.Factory().setTransferListener(object : TransferListener {
      override fun onTransferInitializing(source: DataSource, spec: DataSpec, network: Boolean) {}
      override fun onTransferStart(source: DataSource, spec: DataSpec, network: Boolean) { starts.incrementAndGet(); if (cancelPlain && !spec.httpRequestHeaders.containsKey("Range")) { Thread.currentThread().interrupt(); throw java.io.InterruptedIOException("cancelled plain GET") }; if (interruptRetry && spec.position > 0) Thread.currentThread().interrupt() }
      override fun onBytesTransferred(source: DataSource, spec: DataSpec, network: Boolean, bytes: Int) { transferred.addAndGet(bytes.toLong()) }
      override fun onTransferEnd(source: DataSource, spec: DataSpec, network: Boolean) { ends.incrementAndGet() }
    })
    val ts = NoRangeTs(http, DefaultExtractorsFactory())
    extractorFactory = ts.factory
    var closed: Boolean? = null
    val hold = Hold(Handler(Looper.getMainLooper())) { closed = it }
    val source = hold.factory(ts.readers) { true }.createDataSource()
    try { test(source, Uri.parse(server.url("/title.ts").toString()), requests, hold) { closed } }
    finally { source.close(); hold.retire(); ShadowLooper.idleMainLooper(); server.shutdown() }
  }
}
