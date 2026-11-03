package app.mrstreamer.guide

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.text.Normalizer
import java.util.Locale

class GuideIndex(file: File, private val job: GuideJob, private val disk: GuideDisk, create: Boolean = false, databaseBytes: Long = GuideBudget.DATABASE) : AutoCloseable {
  private val db = SQLiteDatabase.openDatabase(file.path, null, if (create) SQLiteDatabase.CREATE_IF_NECESSARY else SQLiteDatabase.OPEN_READONLY)
  init {
    if (create) {
      // Every sort is backed by the primary key. No SQLite scratch file can escape our root.
      db.execSQL("PRAGMA temp_store=MEMORY")
      db.rawQuery("PRAGMA journal_mode=DELETE", null).use { it.moveToFirst() }
      db.execSQL("PRAGMA synchronous=FULL")
      val page = db.rawQuery("PRAGMA page_size", null).use { it.moveToFirst(); it.getLong(0) }
      db.rawQuery("PRAGMA max_page_count=${databaseBytes / page}", null).use { it.moveToFirst() }
      db.execSQL("CREATE TABLE raw(channel TEXT,start INTEGER,stop INTEGER,title TEXT,description TEXT,PRIMARY KEY(channel,start)) WITHOUT ROWID")
    }
  }
  override fun close() = db.close()
  // SQLite may roll a full transaction back itself. Cleanup must preserve the ingest failure.
  private fun transaction(work: () -> Unit) {
    db.beginTransaction()
    var failure: Exception? = null
    try { work(); db.setTransactionSuccessful() }
    catch (e: Exception) { failure = e; throw e }
    finally {
      try { db.endTransaction() }
      catch (e: Exception) { if (failure == null) throw e else failure.addSuppressed(e) }
    }
  }
  fun ingest(file: File, login: List<String>, uncertain: List<String>, now: Long, from: Long, until: Long): Long {
    // Reserve both the capped database and its rollback journal before any SQL growth.
    disk.check(GuideBudget.DATABASE * 2)
    transaction {
      db.compileStatement("INSERT OR IGNORE INTO raw VALUES(?,?,?,?,?)").use { stmt ->
        readXml(file, job, login, uncertain) { channel, start, stop, title, description ->
          job.check(); stmt.clearBindings(); stmt.bindString(1, channel); stmt.bindLong(2, start)
          if (stop != null) stmt.bindLong(3, stop)
          stmt.bindString(4, title); if (description != null) stmt.bindString(5, description)
          try { stmt.executeInsert() }
          catch (_: android.database.sqlite.SQLiteFullException) { throw GuideFailure("body") }
          catch (_: android.database.sqlite.SQLiteException) { throw GuideFailure("disk") }
        }
      }
    }
    job.check(); disk.check(GuideBudget.DATABASE * 2)
    db.execSQL("CREATE TABLE programmes(channel TEXT,start INTEGER,stop INTEGER,title TEXT,description TEXT,PRIMARY KEY(channel,start)) WITHOUT ROWID")
    var last = Long.MIN_VALUE
    var count = 0
    transaction {
      db.compileStatement("INSERT INTO programmes VALUES(?,?,?,?,?)").use { stmt ->
        db.rawQuery("SELECT channel,start,stop,title,description FROM raw ORDER BY channel,start", null).use { cursor ->
          var previous: Array<Any?>? = null
          fun save(nextChannel: String?, nextStart: Long?) {
            val row = previous ?: return
            val channel = row[0] as String; val start = row[1] as Long
            val next = if (nextChannel == channel) nextStart else null
            val stop = (row[2] as Long?)?.let { if (next == null) it else minOf(it, next) } ?: next ?: return
            if (stop - start < 60000 || stop <= from || start >= until) return
            job.check(); stmt.clearBindings(); stmt.bindString(1, channel); stmt.bindLong(2, start); stmt.bindLong(3, stop)
            stmt.bindString(4, row[3] as String); (row[4] as String?)?.let { stmt.bindString(5, it) }
            try { stmt.executeInsert() }
            catch (_: android.database.sqlite.SQLiteFullException) { throw GuideFailure("body") }
            catch (_: android.database.sqlite.SQLiteException) { throw GuideFailure("disk") }
            last = maxOf(last, stop); count++
          }
          while (cursor.moveToNext()) {
            job.check()
            save(cursor.getString(0), cursor.getLong(1))
            previous = arrayOf(cursor.getString(0), cursor.getLong(1), if (cursor.isNull(2)) null else cursor.getLong(2), cursor.getString(3), cursor.getString(4))
          }
          save(null, null)
        }
      }
    }
    if (count == 0) throw GuideFailure("empty")
    if (last <= now) throw GuideFailure("ended")
    db.execSQL("DROP TABLE raw")
    db.rawQuery("PRAGMA quick_check", null).use { if (!it.moveToFirst() || it.getString(0) != "ok") throw GuideFailure("disk") }
    disk.check()
    return last
  }
  private fun bounded(value: Map<String, Any?>): Map<String, Any?> {
    if (org.json.JSONObject(value).toString().toByteArray().size > 1024 * 1024) throw GuideFailure("reply")
    job.check(); return value
  }
  fun query(ids: List<String>, at: Long, mode: String, from: Long, until: Long, after: Long): Map<String, Any?> {
    if (ids.size > 128 || ids.any { it.toByteArray().size > 512 } || mode !in listOf("day", "listing", "detail")) throw GuideFailure("reply")
    if (mode == "day" && (until <= from || until - from > 26 * 3600000L)) throw GuideFailure("time")
    val selected = ids.firstOrNull { id ->
      job.check()
      val condition = when (mode) { "detail" -> "start=?"; "day" -> "stop>? AND start<?"; else -> "stop>?" }
      val args = when (mode) { "detail" -> arrayOf(id, after.toString()); "day" -> arrayOf(id, from.toString(), until.toString()); else -> arrayOf(id, at.toString()) }
      db.rawQuery("SELECT 1 FROM programmes WHERE channel=? AND $condition LIMIT 1", args).use { it.moveToFirst() }
    } ?: return mapOf("guideId" to null, "rows" to emptyList<Any>(), "more" to false)
    val condition = when (mode) { "listing" -> "stop>? ORDER BY start LIMIT 2"; "detail" -> "start=? LIMIT 1"; else -> "stop>? AND start<? AND start>? ORDER BY start LIMIT 129" }
    val args = mutableListOf(selected, (if (mode == "listing") at else if (mode == "detail") after else from).toString())
    if (mode == "day") args.addAll(listOf(until.toString(), after.toString()))
    val rows = mutableListOf<Map<String, Any?>>()
    db.rawQuery("SELECT start,stop,title,${if (mode == "day") "NULL" else "description"} FROM programmes WHERE channel=? AND $condition", args.toTypedArray()).use { c ->
      while (c.moveToNext()) { job.check(); rows.add(mapOf("start" to c.getLong(0), "stop" to c.getLong(1), "title" to c.getString(2), "description" to c.getString(3))) }
    }
    return bounded(mapOf("guideId" to selected, "rows" to rows.take(128), "more" to (rows.size > 128)))
  }
  fun current(at: Long): Map<String, Any?> {
    val ids = mutableListOf<String>()
    db.rawQuery("SELECT DISTINCT channel FROM programmes WHERE stop>?", arrayOf(at.toString())).use { c ->
      while (c.moveToNext()) { job.check(); if (ids.size >= GuideBudget.CHANNELS) throw GuideFailure("reply"); ids.add(c.getString(0)) }
    }
    return bounded(mapOf("ids" to ids))
  }
  fun search(ids: List<String>, words: List<String>, at: Long, limit: Int): Map<String, Any?> {
    if (ids.size > 65536 || ids.any { it.toByteArray().size > 512 } || words.isEmpty() || words.size > 160 || words.any { it.isEmpty() || it.toByteArray().size > 32768 } || limit !in 1..50) throw GuideFailure("reply")
    val wanted = ids.toSet(); val needles = words.map(::fold)
    data class Match(val id: String, val start: Long, val stop: Long, val title: String)
    val order = compareBy<Match> { if (it.start <= at) 0 else 1 }.thenBy { it.start }.thenBy { it.id }
    val best = mutableListOf<Match>()
    db.rawQuery("SELECT channel,start,stop,title FROM programmes WHERE stop>?", arrayOf(at.toString())).use { c ->
      while (c.moveToNext()) {
        job.check()
        if (c.getString(0) !in wanted) continue
        val title = c.getString(3); val folded = fold(title)
        if (!needles.all { folded.contains(it) }) continue
        best.add(Match(c.getString(0), c.getLong(1), c.getLong(2), title)); best.sortWith(order)
        if (best.size > limit) best.removeAt(best.lastIndex)
      }
    }
    return bounded(mapOf("rows" to best.map { mapOf("guideId" to it.id, "start" to it.start, "stop" to it.stop, "title" to it.title) }))
  }
}
private fun fold(value: String) = Normalizer.normalize(value, Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT).replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()
