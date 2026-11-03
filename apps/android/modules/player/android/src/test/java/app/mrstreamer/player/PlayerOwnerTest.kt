package app.mrstreamer.player

import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.FakeRenderer
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.WebServerDispatcher
import androidx.media3.test.utils.robolectric.RobolectricUtil
import java.io.File
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

// PlayerOwner's public behaviour over a real ExoPlayer reading real files (src/test/resources/media,
// made with ffmpeg as its README says). Robolectric has no decoders: the fake renderers accept every
// picture and sound track, so these prove reading, attempt identity, commands and release, and
// leave decoding to a device (Capabilities and each attempt's reported tracks say what it decodes).

@UnstableApi
@RunWith(RobolectricTestRunner::class)
class PlayerOwnerTest {
  private val context: Context = RuntimeEnvironment.getApplication()
  private val recorder = Recorder()
  private val players = mutableListOf<ExoPlayer>()
  private val servers = mutableListOf<MockWebServer>()

  private class Recorder : PlayerEvents {
    val observations = mutableListOf<Observation>()
    val tracks = mutableMapOf<String, List<Track>>()
    val releases = mutableListOf<Release>()

    override fun observed(observation: Observation) {
      observations += observation
    }

    override fun tracks(attempt: String, tracks: List<Track>) {
      this.tracks[attempt] = tracks
    }

    override fun released(release: Release) {
      releases += release
    }

    fun of(attempt: String) = observations.filter { it.attempt == attempt }
  }

  @After
  fun tearDown() {
    players.forEach { it.release() }
    servers.forEach { it.shutdown() }
  }

  private fun owner(build: (TestExoPlayerBuilder) -> TestExoPlayerBuilder = { it }): PlayerOwner {
    val player = build(TestExoPlayerBuilder(context)).build()
    players += player
    return PlayerOwner(context, player, recorder)
  }

  /** The fixture as a file of its own, as a download would be. */
  private fun fixture(name: String): File {
    val file = File(context.cacheDir, name)
    file.parentFile?.mkdirs()
    javaClass.classLoader!!.getResourceAsStream("media/$name")!!.use { input ->
      file.outputStream().use { input.copyTo(it) }
    }
    return file
  }

  private fun file(attempt: String, file: File, format: String = "progressive", startMs: Long = 0) =
    Admission(attempt, file.toURI().toString(), emptyMap(), format, "file", startMs, HoldRef.LocalFile(file.path))

  private fun until(condition: () -> Boolean) = RobolectricUtil.runMainLooperUntil(condition)

  private fun untilPhase(attempt: String, vararg phases: Phase) =
    until { recorder.of(attempt).lastOrNull()?.phase in phases }

  @Test
  fun replacingAnAttemptStopsItClosesItsFileAndRefusesItsCommands() {
    val owner = owner()
    val first = fixture("h264-aac.mp4")
    owner.admit(file("a", first))
    untilPhase("a", Phase.PLAYING)
    val tracks = recorder.tracks.getValue("a")
    assertEquals(
      listOf("video/avc" to true, "audio/mp4a-latm" to true),
      tracks.map { it.codec to it.supported },
    )
    assertEquals(160, tracks.first { it.type == "video" }.width)

    owner.admit(file("b", fixture("vp9-opus.webm")))
    assertEquals(Phase.STOPPED, recorder.of("a").last().phase)
    until { recorder.releases.any { it.attempt == "a" } }
    assertEquals(Release("a", HoldRef.LocalFile(first.path), "file-closed"), recorder.releases.single())

    assertFalse(owner.pause("a"))
    assertFalse(owner.seek("a", 1_000))
    assertFalse(owner.stop("a"))
    untilPhase("b", Phase.PLAYING)
    assertTrue(owner.pause("b"))
    untilPhase("b", Phase.PAUSED)
  }

  @Test
  fun pausesSeeksResumesAndStopsWhereItWas() {
    val owner = owner()
    owner.admit(file("a", fixture("h264-aac.mp4")))
    untilPhase("a", Phase.PLAYING)
    assertTrue(owner.pause("a"))
    untilPhase("a", Phase.PAUSED)
    assertTrue(owner.seek("a", 2_500))
    until { recorder.of("a").last().positionMs >= 2_500 }
    assertEquals(Phase.PAUSED, recorder.of("a").last().phase)
    assertTrue(owner.setSpeed("a", 1.5f))
    until { recorder.of("a").last().speed == 1.5f }
    assertTrue(owner.resume("a"))
    untilPhase("a", Phase.PLAYING)

    assertTrue(owner.stop("a"))
    val stopped = recorder.of("a").last()
    assertEquals(Phase.STOPPED, stopped.phase)
    assertTrue(stopped.positionMs >= 2_500)
    assertEquals(4_000L, stopped.durationMs?.let { (it + 50) / 1000 * 1000 })
    until { recorder.releases.isNotEmpty() }
    assertEquals("file-closed", recorder.releases.single().outcome)
    assertFalse(owner.resume("a"))
  }

  @Test
  fun startsATitleWhereItWasLeftAndEnds() {
    val owner = owner()
    owner.admit(file("a", fixture("h264-aac.mp4"), startMs = 3_000))
    untilPhase("a", Phase.PLAYING)
    assertTrue(recorder.of("a").last().positionMs >= 3_000)
    untilPhase("a", Phase.ENDED)
  }

  @Test
  fun sendsTheSourcesHeadersAndClosesItsConnectionsWhenStopped() {
    val bytes = javaClass.classLoader!!.getResourceAsStream("media/h264-aac.ts")!!.readBytes()
    val server = MockWebServer().also { servers += it }
    server.dispatcher =
      WebServerDispatcher.forResources(
        listOf(WebServerDispatcher.Resource.Builder().setPath("/live/7.ts").setData(bytes).build()),
      )
    val owner = owner()
    owner.admit(
      Admission(
        "a",
        server.url("/live/7.ts").toString(),
        mapOf("User-Agent" to "MrStreamer-Android/0.1.0", "Referer" to "https://lists.example/"),
        "mpegts",
        "live",
        0,
        HoldRef.Source("m3u:1"),
      ),
    )
    untilPhase("a", Phase.PLAYING, Phase.ENDED)
    val request = server.takeRequest()
    assertEquals("MrStreamer-Android/0.1.0", request.getHeader("User-Agent"))
    assertEquals("https://lists.example/", request.getHeader("Referer"))
    assertTrue(recorder.of("a").last().live)
    assertFalse(owner.seek("a", 1_000))
    assertFalse(owner.setSpeed("a", 2f))

    assertTrue(owner.stop("a"))
    until { recorder.releases.isNotEmpty() }
    assertEquals(Release("a", HoldRef.Source("m3u:1"), "connections-closed"), recorder.releases.single())
  }

  @Test
  fun saysWhatAProviderAnsweredInsteadOfPlaying() {
    val server = MockWebServer().also { servers += it }
    server.dispatcher = WebServerDispatcher.forResources(emptyList())
    val owner = owner()
    owner.admit(
      Admission("a", server.url("/live/7.ts").toString(), emptyMap(), "mpegts", "live", 0, HoldRef.Source("x")),
    )
    untilPhase("a", Phase.FAILED)
    val failure = recorder.of("a").last().failure!!
    assertEquals("http", failure.kind)
    assertEquals(404, failure.status)
    assertFalse(failure.toString().contains("/live/7.ts"))
  }

  @Test
  fun failsTrulyWhenNothingInTheMediaCanPlay() {
    val owner = owner { it.setRenderers(FakeRenderer(C.TRACK_TYPE_TEXT)) }
    owner.admit(file("a", fixture("h264-aac.mp4")))
    untilPhase("a", Phase.FAILED)
    assertEquals("unsupported", recorder.of("a").last().failure?.kind)
    assertTrue(recorder.tracks.getValue("a").none { it.supported })
  }

  @Test
  fun saysAMissingFileIsMissing() {
    val owner = owner()
    val missing = File(context.cacheDir, "gone.mkv")
    owner.admit(file("a", missing))
    assertEquals(Failure("file-missing", "ERROR_CODE_IO_FILE_NOT_FOUND"), recorder.of("a").last().failure)
    assertFalse(owner.resume("a"))
  }

  /**
   * The container, codec and track matrix of the fixtures as this player reads them, printed for
   * the record. Unsupported here means unreadable: decoding is the device's.
   */
  @Test
  fun readsEachContainerAndCodecOfTheMatrix() {
    val expected =
      linkedMapOf(
        "h264-aac.mp4" to listOf("video/avc", "audio/mp4a-latm"),
        "h264-aac.ts" to listOf("video/avc", "audio/mp4a-latm"),
        "mpeg2-mp2.ts" to listOf("video/mpeg2", "audio/mpeg-L2"),
        "hevc-ac3-eac3-srt.mkv" to listOf("video/hevc", "audio/ac3", "audio/eac3", "text"),
        "vp9-opus.webm" to listOf("video/x-vnd.on2.vp9", "audio/opus"),
        "hevc10-eac3.mp4" to listOf("video/hevc", "audio/eac3"),
        "hls/index.m3u8" to listOf("video/avc", "audio/mp4a-latm"),
      )
    fixture("hls/segment0.ts")
    fixture("hls/segment1.ts")
    expected.forEach { (name, codecs) ->
      val owner = owner()
      owner.admit(file(name, fixture(name), format = if (name.endsWith(".m3u8")) "hls" else "progressive"))
      untilPhase(name, Phase.PLAYING, Phase.FAILED)
      val tracks = recorder.tracks.getValue(name)
      println("matrix $name: ${tracks.joinToString { "${it.type} ${it.codec} ${it.language ?: "-"}" }}")
      assertEquals(name, codecs, tracks.map { if (it.type == "text") "text" else it.codec })
      assertEquals(Phase.PLAYING, recorder.of(name).last().phase)
      owner.stop(name)
    }
    val languages = recorder.tracks.getValue("hevc-ac3-eac3-srt.mkv").map { it.language }
    assertEquals(listOf(null, "eng", "deu", "nld"), languages)

    val owner = owner()
    owner.admit(file("not-media", fixture("not-media.bin")))
    untilPhase("not-media", Phase.FAILED)
    println("matrix not-media.bin: ${recorder.of("not-media").last().failure}")
    assertEquals("format", recorder.of("not-media").last().failure?.kind)
  }
}
