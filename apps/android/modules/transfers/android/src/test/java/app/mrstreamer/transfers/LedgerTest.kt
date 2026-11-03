package app.mrstreamer.transfers

import org.robolectric.RuntimeEnvironment
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.json.JSONObject
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LedgerTest {
  @Test fun duplicateAndObsoleteCompletionsCannotReplaceState() {
    val row = JSONObject().put("state", "running").put("attempt", "new")
    assertFalse(Ledger.finish(row, "old", 8, 8))
    assertFalse(Ledger.finish(row, "new", 7, 8))
    assertTrue(Ledger.finish(row, "new", 8, 8))
    assertFalse(Ledger.finish(row, "new", 8, 8))
    assertEquals("complete", row.getString("state"))
  }

  @Test fun resumeRequiresSameRepresentationAndExactOffset() {
    fun accepts(status: Int = 206, range: String = "bytes 8-15/16", etag: String = "one", modified: String = "date", length: Long = 16) =
      Ledger.resumes(8, status, range, etag, modified, "one", "date", length, 16)
    assertTrue(accepts())
    assertFalse(accepts(status = 200))
    assertFalse(accepts(range = "bytes 0-15/16"))
    assertFalse(accepts(etag = "two"))
    assertFalse(accepts(modified = "later"))
    assertFalse(accepts(length = 32))
    assertFalse(Ledger.resumes(8, 206, "bytes 8-15/16", "", "", "", "", 16, 16))
  }

  @Test fun launchNeverReportsMissingOrTruncatedCopyAsDownloaded() {
    for ((length, readable) in listOf(0L to false, 7L to true)) {
      val row = JSONObject().put("state", "complete").put("total", 8)
      Ledger.reconcile(row, length, readable)
      assertEquals("failed", row.getString("state"))
      assertEquals("missing", row.getString("reason"))
    }
    val complete = JSONObject().put("state", "complete").put("total", 8)
    Ledger.reconcile(complete, 8, true)
    assertEquals("complete", complete.getString("state"))
  }

  @Test fun interruptedAttemptIsFencedAndQueueSurvivesNewOwner() {
    val context = RuntimeEnvironment.getApplication()
    val ledger = Ledger(context)
    try {
      val row = JSONObject().put("state", "running").put("attempt", "old")
      Ledger.reconcile(row, 4, true)
      assertEquals("queued", row.getString("state"))
      assertNotEquals("old", row.getString("attempt"))
      ledger.save(listOf(row))
      assertEquals(row.toString(), Ledger(context).read().single().toString())
    } finally { ledger.root.deleteRecursively() }
  }

  @Test fun legacyRowsWithoutTitleFactsStillRestore() {
    val ledger = Ledger(RuntimeEnvironment.getApplication())
    try {
      val row = JSONObject().put("state", "complete").put("total", 8)
      ledger.save(listOf(row))
      val restored = Ledger(RuntimeEnvironment.getApplication()).read().single()
      Ledger.reconcile(restored, 8, true)
      assertEquals("complete", restored.getString("state"))
      assertFalse(restored.has("episode"))
    } finally { ledger.root.deleteRecursively() }
  }

  @Test fun damagedLedgerFailsRatherThanLosingTheQueue() {
    val context = RuntimeEnvironment.getApplication()
    val ledger = Ledger(context)
    try {
      java.io.File(ledger.root, "ledger.json").writeText("broken")
      assertThrows(Exception::class.java) { ledger.read() }
    } finally { ledger.root.deleteRecursively() }
  }
}
