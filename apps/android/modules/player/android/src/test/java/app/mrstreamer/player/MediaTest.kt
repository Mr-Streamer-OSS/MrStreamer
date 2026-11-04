package app.mrstreamer.player

import android.app.KeyguardManager
import android.app.Activity
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.test.utils.TestExoPlayerBuilder
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Player
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import com.google.common.collect.ImmutableList
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MediaTest {
  @After fun reset() = resetPlayerState()

  /** A connected controller may see identity/title, but never the owner's playback address. */
  @Test fun controllerMediaItemsContainOnlyIdentityAndTitle() {
    val context: Context = RuntimeEnvironment.getApplication()
    val owner = PlayerHost.owner(context)
    val file = java.io.File(context.cacheDir, "controller-media.mp4")
    javaClass.classLoader!!.getResourceAsStream("media/h264-aac.mp4")!!.use { input ->
      file.outputStream().use { input.copyTo(it) }
    }
    var controller: androidx.media3.session.MediaController? = null
    val view = androidx.media3.ui.PlayerView(context)
    val events = mutableListOf<MediaItem>()
    val listener = object : Player.Listener {
      override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
        for (index in 0 until timeline.windowCount) {
          events += timeline.getWindow(index, androidx.media3.common.Timeline.Window()).mediaItem
        }
      }
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        mediaItem?.let { events += it }
      }
      override fun onPositionDiscontinuity(old: Player.PositionInfo, new: Player.PositionInfo, reason: Int) {
        old.mediaItem?.let { events += it }
        new.mediaItem?.let { events += it }
      }
    }
    fun checkItem(item: MediaItem, id: String, title: String) {
      assertEquals(id, item.mediaId)
      assertEquals(title, item.mediaMetadata.title.toString())
      assertNull("Controller must not receive local playback configuration", item.localConfiguration)
      assertNull("Controller must not receive a request URI", item.requestMetadata.mediaUri)
      assertEquals(MediaItem.Builder().setMediaId(id).setMediaMetadata(
        androidx.media3.common.MediaMetadata.Builder().setTitle(title).build()).build(), item)
    }
    try {
      owner.attach(view)
      fun admit(id: String, title: String) {
        assertTrue(owner.admit(Admission(id, file.toURI().toString(), emptyMap(), "progressive", "file", 0,
          HoldRef.LocalFile(file.path), title = title)))
      }
      admit("first", "First title")
      val session = PlayerHost.session!!
      val future = androidx.media3.session.MediaController.Builder(context, session.token).buildAsync()
      androidx.media3.test.utils.robolectric.RobolectricUtil.runMainLooperUntil { future.isDone }
      val connected = future.get()
      controller = connected
      connected.addListener(listener)
      session.player.addListener(listener)
      for ((id, title) in listOf("first" to "First title", "replacement" to "Replacement title")) {
        if (id == "replacement") admit(id, title)
        androidx.media3.test.utils.robolectric.RobolectricUtil.runMainLooperUntil {
          connected.currentMediaItem?.mediaId == id && connected.mediaMetadata.title.toString() == title
        }
        for (reader in listOf<Player>(connected, session.player)) {
          checkItem(reader.currentMediaItem!!, id, title)
          checkItem(reader.getMediaItemAt(0), id, title)
          checkItem(reader.currentTimeline.getWindow(0, androidx.media3.common.Timeline.Window()).mediaItem, id, title)
        }
        // The actual renderer still plays the owner's file with its full local configuration.
        assertEquals(android.net.Uri.fromFile(file), view.player!!.currentMediaItem!!.localConfiguration!!.uri)
      }
      assertTrue("Replacement must publish media events", events.isNotEmpty())
      events.forEach { item ->
        checkItem(item, item.mediaId, if (item.mediaId == "first") "First title" else "Replacement title")
      }
      session.player.removeListener(listener)
    } finally {
      controller?.release()
      owner.detach(view)
      owner.stopAll()
      file.delete()
    }
  }

  @Test fun sessionCannotReplaceMediaOrChangeSpeed() {
    val owner = PlayerHost.owner(RuntimeEnvironment.getApplication())
    try {
      owner.admit(Admission("session", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      val exposed = PlayerHost.session!!.player
      exposed.setMediaItem(MediaItem.fromUri("https://example.invalid/file"))
      assertEquals(0, exposed.mediaItemCount)
      exposed.setPlaybackSpeed(2f)
      assertEquals(1f, exposed.playbackParameters.speed)
    } finally { owner.stopAll() }
  }

  @Test fun previewHasNoSessionOrPipAndNormalPlaybackRestoresSession() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    try {
      PlayerPip.attach(activity)
      PlayerPip.started()
      owner.admit(Admission("same", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      assertNotNull(PlayerHost.session)
      shadowOf(activity.packageManager).setSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE, true)
      PlayerPip.watch(true)
      assertTrue(PlayerPip.enter())
      PlayerPip.watch(false)
      owner.admit(Admission("same", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing"), preview = true))
      assertNull(PlayerHost.session)
      PlayerPip.watch(true)
      assertFalse(PlayerPip.enter())
      PlayerPip.watch(false)
      owner.admit(Admission("same", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      assertNotNull(PlayerHost.session)
    } finally { owner.stopAll(); PlayerPip.watch(false); PlayerPip.detach(activity); activity.finish() }
  }

  @Test fun previewsRequireStartedActivityOutsidePipAndEndOnDeparture() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    fun preview() = owner.admit(Admission("preview", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing"), preview = true))
    try {
      PlayerPip.attach(activity)
      assertFalse(preview())
      PlayerPip.started()
      PlayerPip.watch(true)
      assertFalse(preview())
      assertNull(owner.attempt)
      PlayerPip.watch(false)
      preview()
      assertEquals("preview", owner.attempt)
      PlayerPip.stopped(activity)
      assertNull(owner.attempt)
      assertFalse(preview())
      PlayerPip.started()
      preview()
      activity.inPip = true
      PlayerPip.mode(true)
      assertNull(owner.attempt)
      assertFalse(preview())
      owner.admit(Admission("normal", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      PlayerPip.stopped(activity)
      assertEquals("normal", owner.attempt)
    } finally { owner.stopAll(); PlayerPip.detach(activity); activity.finish() }
  }

  @Test fun normalSessionSurvivesStopAndRegistersWhenServiceRestarts() {
    val owner = PlayerHost.owner(RuntimeEnvironment.getApplication())
    fun play(id: String) = owner.admit(Admission(id, "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
    val service = Robolectric.buildService(PlayerMediaService::class.java).create().get()
    try {
      play("first")
      val session = PlayerHost.session!!
      assertFalse(service.sessions.contains(session))
      service.onStartCommand(null, 0, 1)
      assertTrue(service.sessions.contains(session))
      owner.stopAll()
      assertSame(session, PlayerHost.session)
      play("second")
      assertSame(session, PlayerHost.session)
      service.removeSession(session)
      service.onStartCommand(null, 0, 2)
      assertTrue(service.sessions.contains(session))
    } finally { owner.stopAll(); service.onDestroy() }
  }


  @Test fun survivingServiceReplacesReleasedSessionAfterPreview() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    val service = Robolectric.buildService(PlayerMediaService::class.java).create().get()
    fun play(id: String, preview: Boolean = false) = owner.admit(Admission(id, "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing"), preview = preview))
    try {
      PlayerPip.attach(activity); PlayerPip.started()
      play("normal")
      service.onStartCommand(null, 0, 1)
      val old = PlayerHost.session!!
      assertEquals(listOf(old), service.sessions)
      androidx.media3.test.utils.robolectric.RobolectricUtil.runMainLooperUntil { old.connectedControllers.isNotEmpty() }
      owner.stopAll()
      play("preview", true)
      assertFalse(service.sessions.contains(old))
      assertNull(PlayerHost.session)
      play("normal-again")
      val current = PlayerHost.session!!
      assertNotSame(old, current)
      service.onStartCommand(null, 0, 2)
      assertEquals(listOf(current), service.sessions)
    } finally { owner.stopAll(); service.onDestroy(); PlayerPip.detach(activity); activity.finish() }
  }

  @Test fun recreationInPipThenDismissalStopsPlayback() {
    val first = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val second = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(first)
    try {
      PlayerPip.attach(first); PlayerPip.started()
      owner.admit(Admission("pip", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      first.inPip = true; PlayerPip.mode(true)
      PlayerPip.detach(first)
      second.inPip = true
      PlayerPip.attach(second); PlayerPip.started()
      PlayerPip.stopped(second)
      assertEquals("pip", owner.attempt)
      second.inPip = false
      PlayerPip.mode(false)
      assertNull(owner.attempt)
    } finally { PlayerPip.detach(second); owner.stopAll(); first.finish(); second.finish() }
  }

  @Test fun observationsDoNotRefreshControlsAndReplacementDoesNotAnnounceFinalStop() {
    val context: Context = RuntimeEnvironment.getApplication()
    val player = TestExoPlayerBuilder(context).build()
    val owner = PlayerOwner(player)
    val changes = mutableListOf<String?>()
    owner.changed = { changes.add(owner.attempt) }
    fun admit(id: String) = owner.admit(Admission(id, "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
    try {
      admit("one")
      changes.clear()
      owner.reconcile(); owner.reconcile()
      assertTrue(changes.isEmpty())
      admit("two")
      assertFalse(changes.contains(null))
      owner.stopAll()
      assertEquals(null, changes.last())
    } finally { player.release() }
  }

  @Test fun leavingWatchRequestsNotificationPermissionOnceAcrossOwnerRecreation() {
    var activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    fun playAndLeave() {
      val owner = PlayerHost.owner(activity)
      owner.admit(Admission("permission", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      PlayerPip.attach(activity)
      PlayerPip.started()
      PlayerPip.watch(true); PlayerPip.watch(false)
    }
    try {
      playAndLeave()
      assertArrayEquals(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), shadowOf(activity).lastRequestedPermission.requestedPermissions)
      val first = shadowOf(activity).lastRequestedPermission
      PlayerPip.watch(true); PlayerPip.watch(false)
      assertSame(first, shadowOf(activity).lastRequestedPermission)
      PlayerPip.detach(activity)
      activity.finish()
      resetPlayerState()
      activity = Robolectric.buildActivity(Activity::class.java).setup().get()
      playAndLeave()
      assertNull(shadowOf(activity).lastRequestedPermission)
      assertNotNull(PlayerHost.existing()?.attempt)
    } finally { PlayerPip.detach(activity); activity.finish() }
  }

  @org.robolectric.annotation.Implements(Activity::class)
  class NotificationShadow : org.robolectric.shadows.ShadowActivity() {
    var failure: RuntimeException? = null
    var requests = 0
    @org.robolectric.annotation.Implementation
    override fun requestPermissions(permissions: Array<String>, requestCode: Int) {
      requests++
      failure?.let { throw it }
      super.requestPermissions(permissions, requestCode)
    }
  }

  @Test
  @Config(shadows = [NotificationShadow::class])
  fun thrownNotificationRequestsCanRetryAndIneligiblePlaybackDoesNotAsk() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val shadow = org.robolectric.shadow.api.Shadow.extract<NotificationShadow>(activity)
    val owner = PlayerHost.owner(activity)
    try {
      PlayerPip.attach(activity)
      PlayerPip.requestNotifications()
      assertEquals(0, shadow.requests)
      PlayerPip.started()
      assertTrue(owner.admit(Admission("preview", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing"), preview = true)))
      assertEquals("preview", owner.attempt)
      PlayerPip.requestNotifications()
      assertEquals(0, shadow.requests)
      owner.stopAll()
      owner.admit(Admission("normal", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      shadowOf(activity).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
      PlayerPip.requestNotifications()
      assertEquals(0, shadow.requests)
      shadowOf(activity).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
      for (failure in listOf(IllegalStateException(), SecurityException())) {
        shadow.failure = failure
        PlayerPip.requestNotifications()
      }
      assertEquals(2, shadow.requests)
      shadow.failure = null
      PlayerPip.requestNotifications()
      assertEquals(3, shadow.requests)
      PlayerPip.requestNotifications()
      assertEquals(3, shadow.requests)
    } finally { PlayerPip.detach(activity); activity.finish() }
  }

  class PipActivity : Activity() {
    var inPip = false
    override fun isInPictureInPictureMode() = inPip
  }

  @Test fun screenLockKeepsPlayingButDismissalAfterModeFlipStops() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    val keyguard = shadowOf(activity.getSystemService(KeyguardManager::class.java))
    try {
      PlayerPip.attach(activity)
      PlayerPip.started()
      owner.admit(Admission("pip", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      activity.inPip = true; PlayerPip.mode(true)
      keyguard.setKeyguardLocked(true)
      PlayerPip.stopped(activity)
      assertEquals("pip", owner.attempt)
      keyguard.setKeyguardLocked(false)
      activity.inPip = false
      PlayerPip.mode(false)
      assertNull(owner.attempt)
      owner.admit(Admission("expand", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      activity.inPip = true; PlayerPip.mode(true)
      PlayerPip.stopped(activity)
      PlayerPip.started()
      activity.inPip = false; PlayerPip.mode(false)
      assertEquals("expand", owner.attempt)
      activity.inPip = true; PlayerPip.mode(true)
      activity.inPip = false; PlayerPip.mode(false)
      shadowOf(android.os.Looper.getMainLooper()).idle()
      PlayerPip.stopped(activity)
      assertNull(owner.attempt)
    } finally { PlayerPip.detach(activity); owner.stopAll(); activity.finish() }
  }

  @Test fun homeAndPipDoNotRequestNotifications() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    try {
      PlayerPip.attach(activity)
      PlayerPip.started()
      owner.admit(Admission("permission-entry", "file:///missing", emptyMap(), "progressive", "file", 0, HoldRef.LocalFile("/missing")))
      PlayerPip.watch(true)
      PlayerPip.home()
      PlayerPip.enter()
      assertNull(shadowOf(activity).lastRequestedPermission)
    } finally { PlayerPip.detach(activity); owner.stopAll(); PlayerPip.watch(false); activity.finish() }
  }

  @Test fun forgedPipBroadcastCannotControlPlayback() {
    val activity = Robolectric.buildActivity(PipActivity::class.java).setup().get()
    val owner = PlayerHost.owner(activity)
    try {
      PlayerPip.attach(activity)
      PlayerPip.started()
      owner.admit(Admission("guessable", "https://example.invalid/video.mp4", emptyMap(), "progressive", "title", 0, HoldRef.Source("test")))
      val view = androidx.media3.ui.PlayerView(activity)
      owner.attach(view)
      owner.pauseCurrent()
      // The unauthenticated Pause broadcast must not resume paused playback.
      activity.sendBroadcast(android.content.Intent("app.mrstreamer.player.PAUSE").setPackage(activity.packageName).putExtra("attempt", "guessable"))
      shadowOf(android.os.Looper.getMainLooper()).idle()
      assertFalse(view.player!!.playWhenReady)
    } finally { PlayerPip.detach(activity); owner.stopAll(); activity.finish() }
  }

  @Test fun sessionCustomActionsRespectMode() {
    fun has(live: Boolean, next: Boolean, action: String) = PlayerHost.sessionCommands(live, next)
      .contains(androidx.media3.session.SessionCommand(action, android.os.Bundle.EMPTY))
    assertTrue(has(true, true, "close"))
    assertFalse(has(true, true, "back"))
    assertFalse(has(true, true, "next"))
    assertTrue(has(false, false, "back"))
    assertTrue(has(false, false, "forward"))
    assertFalse(has(false, false, "next"))
    assertTrue(has(false, true, "next"))
  }

  @Test fun unsupportedTrackNeverAppearsSelected() {
    val group = TrackGroup(Format.Builder().setSampleMimeType("audio/aac").setLanguage("nl").build())
    val tracks = Tracks(ImmutableList.of(Tracks.Group(group, false,
      intArrayOf(C.FORMAT_UNSUPPORTED_TYPE), booleanArrayOf(true))))
    val track = PlayerOwner.tracksOf(tracks).single()
    assertEquals("audio", track.type)
    assertEquals("nl", track.language)
    assertFalse(track.supported)
    assertFalse(track.selected)
  }
  @Test fun systemCommandsRespectModeAndSuppliedNext() {
    val live = PlayerHost.commands(true, true)
    assertTrue(live.contains(Player.COMMAND_STOP))
    assertTrue(live.contains(Player.COMMAND_PLAY_PAUSE))
    assertFalse(live.contains(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM))
    assertFalse(live.contains(Player.COMMAND_SEEK_TO_NEXT))
    val title = PlayerHost.commands(false, false)
    assertTrue(title.contains(Player.COMMAND_SEEK_BACK))
    assertTrue(title.contains(Player.COMMAND_SEEK_FORWARD))
    assertTrue(title.contains(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM))
    assertFalse(title.contains(Player.COMMAND_SEEK_TO_NEXT))
    assertTrue(PlayerHost.commands(false, true).contains(Player.COMMAND_SEEK_TO_NEXT))
    assertFalse(title.contains(Player.COMMAND_CHANGE_MEDIA_ITEMS))
    assertFalse(title.contains(Player.COMMAND_PREPARE))
    assertFalse(title.contains(Player.COMMAND_SET_SPEED_AND_PITCH))
  }
}
