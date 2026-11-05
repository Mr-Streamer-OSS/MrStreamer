package app.mrstreamer.player

import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.test.utils.FakeRenderer
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.RobolectricUtil
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NoRangeTsOwnerTest {
  private val observations = mutableListOf<Observation>()
  private var tracks = emptyList<Track>()
  private val events = object : PlayerEvents {
    override fun observed(observation: Observation) { observations += observation }
    override fun tracks(attempt: String, tracks: List<Track>) { this@NoRangeTsOwnerTest.tracks = tracks }
    override fun released(release: Release) {}
  }
  private val context = RuntimeEnvironment.getApplication()
  private fun player() = TestExoPlayerBuilder(context)
    .setRenderers(FakeRenderer(C.TRACK_TYPE_VIDEO), FakeRenderer(C.TRACK_TYPE_AUDIO), FakeRenderer(C.TRACK_TYPE_TEXT)).build()
  private fun until(condition: () -> Boolean) = RobolectricUtil.runMainLooperUntil(condition)

  @Test fun titleUsesNoRangeExtractionButLiveDoesNotProbe() {
    for (mode in listOf("title", "live")) {
      val server = MockWebServer()
      val player = player()
      val owner = PlayerOwner(player, events)
      val packet = javaClass.classLoader!!.getResourceAsStream("media/hls/segment0.m2ts")!!.use { it.readBytes() }
      val body = Buffer().write(ByteArray(packet.size * 2000) { packet[it % packet.size] })
      server.enqueue(if (mode == "live") MockResponse().setChunkedBody(body, 4096) else MockResponse().setBody(body))
      try {
        owner.admit(Admission(mode, server.url("/title.ts").toString(), emptyMap(), "mpegts", mode, if (mode == "title") 20_000 else 0, HoldRef.Source("fixture")))
        until { observations.any { it.attempt == mode && it.phase == Phase.PLAYING } }
        val observation = observations.last { it.attempt == mode }
        assertFalse(observation.seekable)
        assertNull(observation.durationMs)
        assertEquals(mode == "live", observation.live)
        assertFalse(owner.seek(mode, 1200))
        assertEquals(if (mode == "title") "bytes=0-" else null, server.takeRequest().getHeader("Range"))
        assertEquals(1, server.requestCount)
        if (mode == "title") {
          assertTrue("Unsupported resume must clamp to the beginning", observation.positionMs < 20_000)
          until { player.currentPosition > 0 }
          owner.pause(mode)
          val position = player.currentPosition
          val item = player.currentMediaItem
          assertFalse(owner.setSidecar(mode, text, "en", 0.0, 1.0))
          assertEquals(position, player.currentPosition)
          assertEquals(item, player.currentMediaItem)
          assertFalse(tracks.any { it.id == Subtitles.TRACK })
          assertEquals(1, server.requestCount)
        }
      } finally { owner.stopAll(); player.release(); server.shutdown() }
    }
  }

  @Test fun resumedRangeTitleRestoresSavedSubtitleBeforeSeekMapPublication() {
    val player = player()
    val owner = PlayerOwner(player, events)
    val server = MockWebServer()
    val media = javaClass.classLoader!!.getResourceAsStream("media/h264-aac.mp4")!!.use { it.readBytes() }
    server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
      override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
        val start = request.getHeader("Range")?.substringAfter("bytes=")?.substringBefore('-')?.toInt() ?: 0
        return MockResponse().setResponseCode(206)
          .addHeader("Content-Range", "bytes $start-${media.lastIndex}/${media.size}")
          .setBody(Buffer().write(media, start, media.size - start))
      }
    }
    try {
      owner.admit(Admission("a", server.url("/title.mp4").toString(), emptyMap(), "progressive", "title", 1000, HoldRef.Source("fixture")))
      owner.pause("a")
      assertEquals(1000L, player.currentPosition)
      assertFalse(player.isCurrentMediaItemSeekable)
      var installed: Boolean? = null
      assertTrue(owner.setSidecar("a", text, "en", 0.0, 1.0) { installed = it })
      assertEquals(1000L, player.currentPosition)
      until { installed != null }
      assertEquals(true, installed)
      until { tracks.any { it.id == Subtitles.TRACK && it.selected } }
      assertTrue(player.isCurrentMediaItemSeekable)
      assertEquals(1000L, player.currentPosition)
      assertFalse(player.playWhenReady)
    } finally { owner.stopAll(); player.release(); server.shutdown() }
  }

  @Test fun confirmedNoRangeAtZeroAllowsRebuildThenKeepsSubtitleAndPlaybackOnRefusal() {
    val real = player()
    val owner = PlayerOwner(real, events)
    val server = MockWebServer()
    val packet = javaClass.classLoader!!.getResourceAsStream("media/hls/segment0.m2ts")!!.use { it.readBytes() }
    val media = ByteArray(packet.size * 2000) { packet[it % packet.size] }
    server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
      override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest) = MockResponse().setBody(Buffer().write(media))
    }
    try {
      owner.admit(Admission("a", server.url("/title.ts").toString(), emptyMap(), "mpegts", "title", 0, HoldRef.Source("fixture")))
      owner.pause("a")
      until { real.playbackState == androidx.media3.common.Player.STATE_READY }
      assertFalse(real.isCurrentMediaItemSeekable)
      assertEquals(0L, real.currentPosition)
      var installed: Boolean? = null
      assertTrue(owner.setSidecar("a", text, "en", 0.0, 1.0) { installed = it })
      until { installed != null }
      assertEquals(true, installed)
      until { tracks.any { it.id == Subtitles.TRACK && it.selected } }
      assertEquals(0L, real.currentPosition)
      owner.resume("a")
      until { real.currentPosition > 0 }
      owner.pause("a")
      val position = real.currentPosition
      val item = real.currentMediaItem
      val selection = real.trackSelectionParameters
      val completions = mutableListOf<Boolean>()
      assertFalse(owner.setSidecar("a", text.replace("Hello", "Changed"), "nl", 0.0, 1.0) { completions += it })
      assertEquals(emptyList<Boolean>(), completions)
      assertEquals(position, real.currentPosition)
      assertEquals(item, real.currentMediaItem)
      assertEquals(selection, real.trackSelectionParameters)
      assertFalse(real.playWhenReady)
      assertTrue(tracks.any { it.id == Subtitles.TRACK && it.selected })
      assertTrue(owner.setSidecar("a", text, "en", 0.0, 1.0) { completions += it })
      assertEquals(listOf(true), completions)
    } finally { owner.stopAll(); real.release(); server.shutdown() }
  }

  @Test fun loaderRetriesTransientPlainGetFailureAndReportsActualCause() {
    val real = player()
    val owner = PlayerOwner(real, events)
    val server = MockWebServer()
    val packet = javaClass.classLoader!!.getResourceAsStream("media/hls/segment0.m2ts")!!.use { it.readBytes() }
    server.enqueue(MockResponse().setResponseCode(403))
    server.enqueue(MockResponse().setResponseCode(503))
    server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(packet.size * 2000) { packet[it % packet.size] })))
    val failures = mutableListOf<java.io.IOException>()
    real.addAnalyticsListener(object : androidx.media3.exoplayer.analytics.AnalyticsListener {
      override fun onLoadError(
        eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime,
        loadEventInfo: androidx.media3.exoplayer.source.LoadEventInfo,
        mediaLoadData: androidx.media3.exoplayer.source.MediaLoadData,
        error: java.io.IOException,
        wasCanceled: Boolean,
      ) { failures += error }
    })
    try {
      owner.admit(Admission("a", server.url("/title.ts").toString(), emptyMap(), "mpegts", "title", 0, HoldRef.Source("fixture")))
      until { observations.lastOrNull()?.phase == Phase.PLAYING }
      val error = failures.single() as androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException
      assertEquals(503, error.responseCode)
      assertEquals(403, (error.suppressed.single() as androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException).responseCode)
      assertEquals(3, server.requestCount)
      assertEquals("bytes=0-", server.takeRequest().getHeader("Range"))
      assertNull(server.takeRequest().getHeader("Range"))
      assertEquals("bytes=0-", server.takeRequest().getHeader("Range"))
    } finally { owner.stopAll(); real.release(); server.shutdown() }
  }

  private val text = "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHello\n"
}
