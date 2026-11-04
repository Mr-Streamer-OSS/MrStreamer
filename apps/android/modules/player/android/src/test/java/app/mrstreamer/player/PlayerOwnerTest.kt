package app.mrstreamer.player

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.FakeRenderer
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.WebServerDispatcher
import androidx.media3.test.utils.robolectric.RobolectricUtil
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

// PlayerOwner's public behaviour over a real ExoPlayer reading real files (src/test/resources/media,
// made with ffmpeg as its README says). Robolectric has no decoders: the fake renderers accept every
// picture and sound track, so these prove reading, attempt identity, commands and release, and
// leave decoding to a device (Capabilities and each attempt's reported tracks say what it decodes).

// Android 14's Robolectric runs on the JDK 17 the Mac mini builds with; 15 and later need 21.
@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
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
    resetPlayerState()
    players.forEach { it.release() }
    servers.forEach { it.shutdown() }
  }

  private fun owner(build: (TestExoPlayerBuilder) -> TestExoPlayerBuilder = { it }): PlayerOwner {
    val player = build(TestExoPlayerBuilder(context)).build()
    players += player
    return PlayerOwner(player, recorder)
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

  /**
   * A live channel: MPEG-TS with no length, as a provider sends it, still arriving for seconds
   * when [throttled]. (Robolectric's clock runs ahead while the player waits, so a throttled
   * stream is stopped before it plays: waiting would trip Media3's stuck-buffering timeout.)
   */
  private fun live(throttled: Boolean): MockWebServer {
    val bytes = javaClass.classLoader!!.getResourceAsStream("media/h264-aac.m2ts")!!.readBytes()
    val server = MockWebServer().also { servers += it }
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          val response = MockResponse().setChunkedBody(Buffer().write(bytes), 4096)
          return if (throttled) response.throttleBody(16_384, 1, TimeUnit.SECONDS) else response
        }
      }
    return server
  }

  private fun until(condition: () -> Boolean) = RobolectricUtil.runMainLooperUntil(condition)

  private fun untilPhase(attempt: String, vararg phases: Phase) =
    until { recorder.of(attempt).lastOrNull()?.phase in phases }

  @Test fun downloadedTextUsesTheExistingOwnerAndReportsItsSelection() {
    val owner = owner { it.setRenderers(FakeRenderer(C.TRACK_TYPE_VIDEO), FakeRenderer(C.TRACK_TYPE_AUDIO), FakeRenderer(C.TRACK_TYPE_TEXT)) }
    val media = fixture("h264-aac.mp4")
    try {
      owner.admit(file("subtitle", media))
      until { recorder.tracks["subtitle"]?.any { it.type == "video" } == true }
      assertTrue(owner.pause("subtitle"))
      assertTrue(owner.seek("subtitle", 500))
      val text = "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHello\n"
      assertFalse(owner.setSidecar("other", text, "en", 0.0, 1.0))
      assertTrue(owner.setSidecar("subtitle", text, "en", 0.1, 1.0))
      until { recorder.tracks["subtitle"]?.any { it.id == Subtitles.TRACK && it.selected } == true }
      assertFalse(owner.isPlaying)
      assertEquals(500L, recorder.of("subtitle").last().positionMs)
      assertTrue(owner.seek("subtitle", 1000))
      assertTrue(owner.setText("subtitle", null))
      until { recorder.tracks["subtitle"]?.none { it.type == "text" && it.selected } == true }
      assertTrue(owner.setText("subtitle", Subtitles.TRACK))
      until { recorder.tracks["subtitle"]?.any { it.id == Subtitles.TRACK && it.selected } == true }
      owner.stop("subtitle")
      until { recorder.releases.any { it.attempt == "subtitle" } }
    } finally { media.delete() }
  }

  @Test fun offDuringSidecarPrepareSettlesAndAllowsAnotherApply() {
    val owner = owner { it.setRenderers(FakeRenderer(C.TRACK_TYPE_VIDEO), FakeRenderer(C.TRACK_TYPE_AUDIO), FakeRenderer(C.TRACK_TYPE_TEXT)) }
    val media = fixture("h264-aac.mp4")
    try {
      owner.admit(file("cancel-sidecar", media))
      until { recorder.tracks["cancel-sidecar"]?.any { it.type == "video" } == true }
      val text = "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHello\n"
      var applied: Boolean? = null
      assertTrue(owner.setSidecar("cancel-sidecar", text, "en", 0.0, 1.0) { applied = it })
      assertTrue(owner.setText("cancel-sidecar", null))
      assertEquals(false, applied)
      assertTrue(owner.setSidecar("cancel-sidecar", text, "en", 1.0, 1.0) { applied = it })
      until { applied == true }
      owner.stop("cancel-sidecar")
    } finally { media.delete() }
  }

  @Test fun sidecarKeepsTheChosenAudioAndReportsPrepareFailure() {
    val owner = owner { it.setRenderers(FakeRenderer(C.TRACK_TYPE_VIDEO), FakeRenderer(C.TRACK_TYPE_AUDIO), FakeRenderer(C.TRACK_TYPE_TEXT)) }
    val media = fixture("hevc-ac3-eac3-srt.mkv")
    try {
      owner.admit(file("audio-sidecar", media))
      until { recorder.tracks["audio-sidecar"]?.count { it.type == "audio" } == 2 }
      val chosen = recorder.tracks["audio-sidecar"]!!.last { it.type == "audio" }
      assertTrue(owner.setAudio("audio-sidecar", chosen.id))
      until { recorder.tracks["audio-sidecar"]?.any { it.type == "audio" && it.codec == chosen.codec && it.selected } == true }
      val text = "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHello\n"
      var applied: Boolean? = null
      assertTrue(owner.setSidecar("audio-sidecar", text, "en", 0.0, 1.0) { applied = it })
      assertEquals(null, applied)
      until { applied != null }
      assertEquals(true, applied)
      assertEquals(chosen.codec, recorder.tracks["audio-sidecar"]!!.single { it.type == "audio" && it.selected }.codec)
      media.delete()
      applied = null
      assertTrue(owner.setSidecar("audio-sidecar", text, "en", 1.0, 1.0) { applied = it })
      until { applied != null }
      assertEquals(false, applied)
      owner.stop("audio-sidecar")
    } finally { media.delete() }
  }

  @Test fun previewIsMutedAndNeverRequestsAudioFocus() {
    val player = TestExoPlayerBuilder(context)
      .setRenderers(FakeRenderer(C.TRACK_TYPE_VIDEO), FakeRenderer(C.TRACK_TYPE_AUDIO)).build()
    players += player
    player.setAudioAttributes(androidx.media3.common.AudioAttributes.DEFAULT, true)
    val owner = PlayerOwner(player, recorder)
    val media = fixture("h264-aac.mp4")
    val activity = Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    PlayerPip.attach(activity); PlayerPip.started()
    try {
      owner.admit(file("preview", media).copy(preview = true))
      until { recorder.of("preview").any { it.phase == Phase.PLAYING } }
      assertEquals(0f, player.volume)
      val audio = org.robolectric.Shadows.shadowOf(context.getSystemService(android.media.AudioManager::class.java))
      assertEquals(null, audio.lastAudioFocusRequest)
      owner.admit(file("normal", media))
      until { recorder.of("normal").any { it.phase == Phase.PLAYING } }
      assertEquals(1f, player.volume)
      assertTrue(audio.lastAudioFocusRequest != null)
    } finally { owner.stopAll(); media.delete(); PlayerPip.detach(activity); activity.finish() }
  }

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
  fun startsAFileWhereItWasLeftAndEnds() {
    val owner = owner()
    owner.admit(file("a", fixture("h264-aac.mp4"), startMs = 3_000))
    untilPhase("a", Phase.PLAYING)
    assertTrue(recorder.of("a").last().positionMs >= 3_000)
    untilPhase("a", Phase.ENDED)
  }

  @Test
  fun sendsTheSourcesHeadersAndClosesItsConnectionsWhenStopped() {
    val server = live(throttled = true)
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
    // Stopped while the stream is still arriving, its connection open.
    until { server.requestCount > 0 }
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
  fun choosesAVideoQualityAndThenChoosesByItselfAgain() {
    val ladder = listOf("index.m3u8") + listOf("v0", "v1").flatMap { variant ->
      listOf("index.m3u8", "segment0.m2ts", "segment1.m2ts").map { "$variant/$it" }
    }
    val files = ladder.map { fixture("hls-ladder/$it") }
    val owner = owner()
    owner.admit(file("a", files.first(), format = "hls").copy(mode = "live"))
    untilPhase("a", Phase.PLAYING)
    val video = recorder.tracks.getValue("a").filter { it.type == "video" }
    assertEquals(listOf(180, 90), video.map { it.height })
    val (high, low) = video

    assertTrue(owner.setQuality("a", low.id))
    until { recorder.tracks.getValue("a").filter { it.selected }.map { it.id }.containsAll(listOf(low.id)) &&
      recorder.tracks.getValue("a").none { it.id == high.id && it.selected } }
    assertFalse(owner.setQuality("a", "99:0"))
    assertFalse(owner.setQuality("a", "${low.id}:junk"))
    assertFalse(owner.setQuality("b", low.id))
    assertTrue(owner.setQuality("a", null))
    until { recorder.tracks.getValue("a").first { it.id == high.id }.selected }
  }

  @Test
  fun keepsARecordingsPlaceWhenItsPlaylistHasNoEnd() {
    fixture("hls/segment0.m2ts")
    fixture("hls/segment1.m2ts")
    val event = fixture("hls/event.m3u8")
    val owner = owner()
    owner.admit(
      Admission("a", event.toURI().toString(), emptyMap(), "hls", "archive", 0, HoldRef.LocalFile(event.path)),
    )
    untilPhase("a", Phase.PLAYING)
    assertTrue(owner.pause("a"))
    assertTrue(owner.seek("a", 3_000))
    until { recorder.of("a").last().positionMs >= 3_000 }
    assertTrue(owner.resume("a"))
    until { recorder.of("a").last().phase == Phase.PLAYING }
    val playing = recorder.of("a").last()
    assertTrue(playing.positionMs >= 3_000)
    assertFalse(playing.live)
    assertTrue(playing.durationMs != null)
    assertTrue(owner.setSpeed("a", 1.5f))
  }

  @Test
  fun playsAFileWhoseNameHoldsUrlCharacters() {
    val odd = File(context.cacheDir, "Ep #1 ?100%.mp4")
    fixture("h264-aac.mp4").copyTo(odd, overwrite = true)
    val owner = owner()
    owner.admit(file("a", odd))
    untilPhase("a", Phase.PLAYING)
  }

  @Test
  fun readsOnlyTheAddressesAnAttemptMay() {
    fun admission(url: String, hold: HoldRef = HoldRef.Source("x")) =
      Admission("a", url, emptyMap(), "hls", "live", 0, hold)
    val https = admission("https://tv.example/live.m3u8")
    val http = admission("http://tv.example/live.m3u8")
    val file = admission("file:///data/a.m3u8", HoldRef.LocalFile("/data/a.m3u8"))
    assertTrue(PlayerOwner.allows(https, Uri.parse("https://cdn.example/1.ts")))
    assertFalse(PlayerOwner.allows(https, Uri.parse("http://cdn.example/1.ts")))
    assertTrue(PlayerOwner.allows(http, Uri.parse("http://cdn.example/1.ts")))
    assertTrue(PlayerOwner.allows(http, Uri.parse("https://cdn.example/1.ts")))
    assertFalse(PlayerOwner.allows(http, Uri.parse("file:///data/user/0/app/files/secret")))
    assertFalse(PlayerOwner.allows(https, Uri.parse("content://media/1")))
    assertTrue(PlayerOwner.allows(file, Uri.parse("file:///data/1.ts")))
    assertFalse(PlayerOwner.allows(file, Uri.parse("https://cdn.example/1.ts")))
  }

  @Test
  fun aReleasedHoldSettlesOnceAndOpensNothingMore() {
    val settled = mutableListOf<Boolean>()
    val hold = Hold(Handler(Looper.getMainLooper())) { settled += it }
    val source = fixture("h264-aac.mp4")
    val reader = hold.factory(DataSource.Factory { FileDataSource() }) { true }.createDataSource()
    reader.open(DataSpec(Uri.fromFile(source)))
    hold.retire()
    ShadowLooper.idleMainLooper()
    assertEquals(emptyList<Boolean>(), settled)
    reader.close()
    until { settled.isNotEmpty() }
    hold.timeOut()
    ShadowLooper.idleMainLooper()
    assertEquals(listOf(true), settled)
    val late = hold.factory(DataSource.Factory { FileDataSource() }) { true }.createDataSource()
    assertThrows(IOException::class.java) { late.open(DataSpec(Uri.fromFile(source))) }
    late.close()
  }

  @Test
  fun saysALiveStreamThatEndedLostItsConnection() {
    val server = live(throttled = false)
    val owner = owner()
    owner.admit(Admission("a", server.url("/live/7.ts").toString(), emptyMap(), "mpegts", "live", 0, HoldRef.Source("x")))
    untilPhase("a", Phase.FAILED)
    assertEquals(Failure("network", "STREAM_ENDED"), recorder.of("a").last().failure)
    assertTrue(owner.resume("a"))
    until { recorder.of("a").last().phase != Phase.FAILED }
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
        "h264-aac.m2ts" to listOf("video/avc", "audio/mp4a-latm"),
        "mpeg2-mp2.m2ts" to listOf("video/mpeg2", "audio/mpeg-L2"),
        "hevc-ac3-eac3-srt.mkv" to listOf("video/hevc", "audio/ac3", "audio/eac3", "text"),
        "vp9-opus.webm" to listOf("video/x-vnd.on2.vp9", "audio/opus"),
        "hevc10-eac3.mp4" to listOf("video/hevc", "audio/eac3"),
        // An HLS stream that doesn't say it has no captions may carry them in its picture.
        "hls/index.m3u8" to listOf("video/avc", "audio/mp4a-latm", "text"),
      )
    fixture("hls/segment0.m2ts")
    fixture("hls/segment1.m2ts")
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
    assertEquals(listOf(null, "en", "de", "nl"), languages)

    val owner = owner()
    owner.admit(file("not-media", fixture("not-media.bin")))
    untilPhase("not-media", Phase.FAILED)
    println("matrix not-media.bin: ${recorder.of("not-media").last().failure}")
    assertEquals("format", recorder.of("not-media").last().failure?.kind)
  }
}
