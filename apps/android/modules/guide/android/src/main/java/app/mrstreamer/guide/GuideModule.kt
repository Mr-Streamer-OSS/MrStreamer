package app.mrstreamer.guide

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import expo.modules.kotlin.Promise
import java.util.concurrent.Executors

class GuideModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val workers = Executors.newFixedThreadPool(4)
  private val available by lazy { runCatching { GuideOwner(File(context.noBackupFilesDir, "guides")) }.getOrNull() }
  private val owner get() = available ?: throw GuideFailure("unavailable")
  private fun dispatch(promise: Promise, work: () -> Unit) {
    workers.execute {
      try { work() } catch (_: Exception) { promise.resolve(mapOf("kind" to "failed", "error" to "unavailable")) }
    }
  }
  override fun definition() = ModuleDefinition {
    Name("Guide")
    Events("foreground", "background")
    OnActivityEntersForeground { sendEvent("foreground") }
    OnActivityEntersBackground { workers.execute { available?.background() }; sendEvent("background") }
    Function("begin") { lease: String, job: String -> runCatching { owner.begin(lease, job) }.getOrDefault(false) }
    Function("revoke") { id: String -> available?.revoke(id) }
    AsyncFunction("restore") { ids: List<String>, kept: List<String> -> owner.restore(ids, kept) }
    AsyncFunction("attach") { id: String, revision: Int -> owner.attach(id, revision) }
    AsyncFunction("forget") { id: String, promise: Promise ->
      dispatch(promise) { owner.forget(id).whenComplete { value, error -> promise.resolve(if (error == null) value else false) } }
    }
    AsyncFunction("cancel") { id: String -> owner.cancel(id) }
    // Object arguments avoid Expo's positional arity limit. The public JS adapter stays iOS-compatible.
    AsyncFunction("prepareRequest") { args: Map<String, Any?>, promise: Promise ->
      dispatch(promise) { owner.prepare(args.text("lease"), args.text("job"), args.text("url"), args.headers(), args.strings("login"), args.strings("uncertain"), args.number("now"), args.number("from"), args.number("until")).whenComplete { value, error -> promise.resolve(if (error == null) value else mapOf("kind" to "failed", "error" to "unavailable")) } }
    }
    AsyncFunction("publish") { lease: String, job: String, candidate: String -> owner.publish(lease, job, candidate) }
    AsyncFunction("queryRequest") { args: Map<String, Any?>, promise: Promise ->
      dispatch(promise) { owner.read(args.text("lease"), args.text("generation"), args.text("job")) { it.query(args.strings("ids"), args.number("at"), args.text("mode"), args.number("from"), args.number("until"), args.number("after")) }.whenComplete { value, error -> promise.resolve(if (error == null) value else mapOf("kind" to "failed", "error" to "unavailable")) } }
    }
    AsyncFunction("current") { lease: String, generation: String, job: String, at: Double, promise: Promise ->
      dispatch(promise) { owner.read(lease, generation, job) { it.current(at.toLong()) }.whenComplete { value, error -> promise.resolve(if (error == null) value else mapOf("kind" to "failed", "error" to "unavailable")) } }
    }
    AsyncFunction("search") { lease: String, generation: String, job: String, ids: List<String>, words: List<String>, at: Double, limit: Int, promise: Promise ->
      dispatch(promise) { owner.read(lease, generation, job) { it.search(ids, words, at.toLong(), limit) }.whenComplete { value, error -> promise.resolve(if (error == null) value else mapOf("kind" to "failed", "error" to "unavailable")) } }
    }
    AsyncFunction("readLink") { id: String -> GuideCredentials.read(context, id) }
    AsyncFunction("writeLink") { id: String, link: String -> GuideCredentials.write(context, id, link) }
    AsyncFunction("removeLink") { id: String -> GuideCredentials.remove(context, id) }
  }
}
private fun Map<String, Any?>.text(key: String) = this[key] as? String ?: throw GuideFailure("reply")
private fun Map<String, Any?>.number(key: String): Long {
  val value = this[key] as? Number ?: throw GuideFailure("reply")
  if (!value.toDouble().isFinite()) throw GuideFailure("reply")
  return value.toLong()
}
private fun Map<String, Any?>.strings(key: String) = (this[key] as? List<*>)?.map { it as? String ?: throw GuideFailure("reply") } ?: throw GuideFailure("reply")
private fun Map<String, Any?>.headers() = (this["headers"] as? Map<*, *>)?.entries?.associate { (key, value) -> (key as? String ?: throw GuideFailure("reply")) to (value as? String ?: throw GuideFailure("reply")) } ?: throw GuideFailure("reply")
