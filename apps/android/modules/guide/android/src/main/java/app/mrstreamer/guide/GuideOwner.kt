package app.mrstreamer.guide

import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.CompletableFuture

/** A short state lock fences every publication against cancellation and revocation. Network,
 * parsing and queries run on separate workers; published databases are immutable. */
class GuideOwner(root: File) {
  private val disk = GuideDisk(root)
  private val lock = Any()
  private data class Entry(val id: String, val lease: String, val revision: Int, var generation: Map<String, Any?>?)
  private data class Candidate(val lease: String, val job: String, val generation: Map<String, Any?>, val file: File)
  private val entries = mutableMapOf<String, Entry>()
  private val jobs = mutableMapOf<String, GuideJob>()
  private val activeReads = mutableMapOf<File, Int>()
  private val retired = mutableSetOf<File>()
  private val candidates = mutableMapOf<String, Candidate>()
  private val ingest = Executors.newSingleThreadExecutor()
  private val readers = Executors.newFixedThreadPool(2)
  private fun folder(id: String): File {
    val name = MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).joinToString("") { "%02x".format(it) }
    return File(disk.root, name).apply {
      if (!exists() && !mkdirs()) throw GuideFailure("disk")
      val metadata = File(this, "owner")
      if (!metadata.exists()) metadata.writeText(id)
    }
  }
  private fun file(entry: Entry, generation: String) = File(folder(entry.id), "$generation.db")
  private fun receipt(id: String): Map<String, Any?>? {
    val atomic = AtomicFile(File(folder(id), "current.json"))
    if (!atomic.baseFile.exists() && !File(atomic.baseFile.path + ".bak").exists()) return null
    val value = JSONObject(String(atomic.readFully(), Charsets.UTF_8))
    val generation = value.getString("id")
    if (!Regex("[a-f0-9-]{36}").matches(generation) || !File(folder(id), "$generation.db").isFile) throw GuideFailure("disk")
    return mapOf("id" to generation, "fetchedAt" to value.getLong("fetchedAt"), "until" to value.getLong("until"))
  }
  init {
    disk.root.listFiles()?.filter { it.isDirectory }?.forEach { dir ->
      val current = AtomicFile(File(dir, "current.json"))
      val retained = try { JSONObject(String(current.readFully(), Charsets.UTF_8)).getString("id") }
        catch (_: java.io.FileNotFoundException) { null }
        catch (_: Exception) { return@forEach }
      dir.listFiles()?.filter { it.name !in setOf("owner", "current.json", "$retained.db") }?.forEach {
        if (!it.delete()) throw GuideFailure("disk")
      }
    }
  }
  fun attach(id: String, revision: Int): Map<String, Any?> = synchronized(lock) {
    if (id.isEmpty() || id.length > 512) throw GuideFailure("reply")
    val old = entries[id]
    if (old != null && old.revision == revision) return mapOf("lease" to old.lease, "generation" to old.generation)
    revoke(id)
    val entry = Entry(id, UUID.randomUUID().toString(), revision, receipt(id))
    entries[id] = entry
    mapOf("lease" to entry.lease, "generation" to entry.generation)
  }
  fun restore(ids: List<String>, kept: List<String>): List<Map<String, Any?>> = synchronized(lock) {
    background(); entries.clear()
    // Folder names are hashed, so persisted owner names live only in non-secret metadata.
    val retain = ids.map { folder(it).name }.toSet()
    disk.root.listFiles()?.filter { dir ->
      dir.isDirectory && dir.name !in retain && !runCatching {
        val owner = File(dir, "owner").readText()
        kept.any { owner.startsWith(it) }
      }.getOrDefault(false)
    }?.forEach { if (!it.deleteRecursively()) throw GuideFailure("disk") }
    ids.mapNotNull { id -> runCatching { mapOf("subscriptionId" to id, "activation" to attach(id, 0)) }.getOrNull() }
  }
  fun revoke(id: String) = synchronized(lock) {
    val lease = entries.remove(id)?.lease
    jobs.values.filter { it.lease == lease }.forEach { it.cancel() }
  }
  fun background() = synchronized(lock) { jobs.values.forEach { it.cancel() } }
  fun begin(lease: String, id: String): Boolean = synchronized(lock) {
    if (jobs.size >= 64 || jobs.containsKey(id) || entries.values.none { it.lease == lease }) false
    else { jobs[id] = GuideJob(lease); true }
  }
  fun cancel(id: String) = synchronized(lock) {
    jobs.remove(id)?.cancel()
    candidates.filterValues { it.job == id }.keys.toList().forEach { candidates.remove(it)?.file?.delete() }
  }
  fun forget(id: String): CompletableFuture<Boolean> {
    revoke(id)
    // Serialize erasure behind any ingest that still has this owner's candidate open.
    return CompletableFuture.supplyAsync({ synchronized(lock) { if (entries.containsKey(id)) false else folder(id).deleteRecursively() } }, ingest)
  }
  private fun job(lease: String, id: String): Pair<Entry, GuideJob> = synchronized(lock) {
    val entry = entries.values.firstOrNull { it.lease == lease } ?: throw GuideFailure("changed")
    val job = jobs[id]?.takeIf { it.lease == lease } ?: throw GuideFailure("cancelled")
    if (job.cancelled) throw GuideFailure("cancelled")
    entry to job
  }
  fun prepare(lease: String, id: String, address: String, headers: Map<String, String>, login: List<String>, uncertain: List<String>, now: Long, from: Long, until: Long): CompletableFuture<Map<String, Any?>> = CompletableFuture.supplyAsync({
    result {
      val (entry, job) = job(lease, id)
      job.deadline = android.os.SystemClock.elapsedRealtime() + 180000
      val generation = UUID.randomUUID().toString()
      val folder = folder(entry.id)
      val spool = File(folder, "$generation.wire"); val plain = File(folder, "$generation.xml"); val database = File(folder, "$generation.db")
      var keep = false
      try {
        val url = try { URL(address) } catch (_: Exception) { throw GuideFailure("redirect") }
        if (url.protocol !in listOf("http", "https")) throw GuideFailure("redirect")
        val client = okhttp3.OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
          .cookieJar(okhttp3.CookieJar.NO_COOKIES).cache(null)
          .authenticator(okhttp3.Authenticator.NONE).proxyAuthenticator(okhttp3.Authenticator.NONE)
          .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS).readTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
          .callTimeout(180, java.util.concurrent.TimeUnit.SECONDS).build()
        val request = okhttp3.Request.Builder().url(address)
        headers.forEach { (key, value) -> request.header(key, value) }
        request.header("Accept-Encoding", "identity").header("Cache-Control", "no-store")
        val call = client.newCall(request.build()); job.connection = call
        try {
          job.check()
          call.execute().use { response ->
            val code = response.code
            if (code in listOf(301, 302, 303, 307, 308)) {
              val location = response.header("Location") ?: throw GuideFailure("redirect")
              if (location.toByteArray().size > 8192) throw GuideFailure("redirect")
              return@result mapOf("kind" to "redirect", "location" to location)
            }
            if (code == 401 || code == 403) throw GuideFailure("login")
            if (code !in 200..299) throw GuideFailure("http")
            val body = response.body ?: throw GuideFailure("body")
            if (body.contentLength() > GuideBudget.BODY) throw GuideFailure("body")
            body.byteStream().use { disk.copy(it, spool, GuideBudget.BODY, job) }
          }
        } catch (e: GuideFailure) { throw e }
        catch (_: Exception) { job.check(); throw GuideFailure("network") }
        finally { call.cancel(); job.connection = null; client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
        disk.unpack(spool, plain, job)
        val end = GuideIndex(database, job, disk, true).use { it.ingest(plain, login, uncertain, now, from, until) }
        synchronized(lock) {
          job(lease, id)
          val value = mapOf("id" to generation, "fetchedAt" to now, "until" to end)
          candidates[generation] = Candidate(lease, id, value, database); keep = true
        }
        mapOf("kind" to "candidate", "id" to generation)
      } finally {
        spool.delete(); plain.delete()
        if (!keep) { database.delete(); File(database.path + "-journal").delete() }
      }
    }
  }, ingest)
  fun publish(lease: String, id: String, candidateId: String): Map<String, Any?> = result {
    synchronized(lock) {
      val (entry, job) = job(lease, id)
      val candidate = candidates[candidateId]?.takeIf { it.lease == lease && it.job == id } ?: throw GuideFailure("changed")
      disk.check(8192); job.check()
      val atomic = AtomicFile(File(folder(entry.id), "current.json"))
      val stream = atomic.startWrite()
      try { stream.write(JSONObject(candidate.generation).toString().toByteArray()); job.check(); atomic.finishWrite(stream) }
      catch (e: Exception) { atomic.failWrite(stream); throw e }
      val old = entry.generation?.get("id") as? String
      entry.generation = candidate.generation; candidates.remove(candidateId)
      if (old != null && old != candidateId) {
        val previous = file(entry, old)
        if ((activeReads[previous] ?: 0) == 0) previous.delete() else retired.add(previous)
      }
      candidate.generation
    }
  }
  fun read(lease: String, generation: String, id: String, action: (GuideIndex) -> Map<String, Any?>): CompletableFuture<Map<String, Any?>> = CompletableFuture.supplyAsync({
    result {
      val (entry, job) = job(lease, id)
      val database = synchronized(lock) {
        if (entry.generation?.get("id") != generation) throw GuideFailure("changed")
        file(entry, generation).also { activeReads[it] = (activeReads[it] ?: 0) + 1 }
      }
      try {
        job.deadline = android.os.SystemClock.elapsedRealtime() + 2000
        val value = GuideIndex(database, job, disk).use(action)
        synchronized(lock) { if (job(lease, id).first.generation?.get("id") != generation) throw GuideFailure("changed"); value }
      } finally {
        synchronized(lock) {
          val count = (activeReads[database] ?: 1) - 1
          if (count == 0) { activeReads.remove(database); if (retired.remove(database)) database.delete() }
          else activeReads[database] = count
        }
      }
    }
  }, readers)
}
