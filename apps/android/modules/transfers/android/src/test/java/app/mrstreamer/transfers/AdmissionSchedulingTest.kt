package app.mrstreamer.transfers

import android.content.Context
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

@Implements(WorkManager::class)
class UnavailableScheduler {
  companion object {
    @JvmStatic @Implementation fun getInstance(context: Context): WorkManager = error("scheduler unavailable")
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [DownloadCredentialShadow::class, DownloadBindingShadow::class, UnavailableScheduler::class],
  instrumentedPackages = ["app.mrstreamer.credentials", "app.mrstreamer.transfers"])
class AdmissionSchedulingTest {
  @Test fun admissionCountsDurableAddEvenWhenSchedulingThrowsAfterSave() {
    val context: Context = RuntimeEnvironment.getApplication()
    val ledger = Ledger(context)
    ledger.root.deleteRecursively()
    DownloadCredentialShadow.authority = "fixture"
    DownloadBindingShadow.binding = "fixture"
    val request = JSONObject().put("sourceId", "source").put("kind", "episode")
      .put("mediaId", "one").put("container", "mp4").put("title", "Series")
      .put("key", JSONArray(listOf("source", "episode", "one", "mp4")).toString())
    val token = JSONObject(Transfers.review(context, JSONArray(listOf(request)).toString())).getString("token")
    try {
      assertEquals("added", Transfers.admit(context, token, request.getString("key"), "none"))
      assertEquals("queued", ledger.read().single().getString("state"))
      assertEquals("skipped", Transfers.admit(context, token, request.getString("key"), "none"))
      val old = ledger.read().single().put("state", "failed").put("reason", "file-changed")
      val oldId = old.getString("id")
      ledger.media(oldId).writeText("changed")
      ledger.artwork(oldId).writeText("art")
      old.put("artwork", android.net.Uri.fromFile(ledger.artwork(oldId)).toString())
      ledger.save(listOf(old))
      val replaceToken = JSONObject(Transfers.review(context, JSONArray(listOf(request)).toString())).getString("token")
      try {
        assertEquals("replaced", Transfers.admit(context, replaceToken, request.getString("key"), "changed"))
        val replacement = ledger.read().single()
        assertNotEquals(oldId, replacement.getString("id"))
        val image = ledger.artwork(replacement.getString("id"))
        assertEquals("art", image.readText())
        assertEquals(android.net.Uri.fromFile(image).toString(), replacement.getString("artwork"))
        assertFalse(ledger.artwork(oldId).exists())
      } finally { Transfers.endReview(replaceToken) }

    } finally {
      Transfers.endReview(token)
      DownloadCredentialShadow.authority = null
      DownloadBindingShadow.binding = "test-binding"
      ledger.save(emptyList())
      ledger.root.deleteRecursively()
    }
  }
}
