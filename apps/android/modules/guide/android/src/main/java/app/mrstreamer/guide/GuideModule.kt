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
  private val owner by lazy { GuideOwner(File(context.noBackupFilesDir, "guides")) }
  override fun definition() = ModuleDefinition {
    Name("Guide")
    Events("foreground", "background")
    OnActivityEntersForeground { sendEvent("foreground") }
    OnActivityEntersBackground { owner.background(); sendEvent("background") }
    Function("begin") { lease: String, job: String -> owner.begin(lease, job) }
    Function("revoke") { id: String -> owner.revoke(id) }
    AsyncFunction("restore") { ids: List<String>, kept: List<String> -> owner.restore(ids, kept) }
    AsyncFunction("attach") { id: String, revision: Int -> owner.attach(id, revision) }
    AsyncFunction("forget") { id: String -> owner.forget(id) }
    AsyncFunction("cancel") { id: String -> owner.cancel(id) }
    // Object arguments avoid Expo's positional arity limit. The public JS adapter stays iOS-compatible.
    AsyncFunction("prepareRequest") { args: Map<String, Any?>, promise: Promise ->
      workers.execute { promise.resolve(owner.prepare(args.text("lease"), args.text("job"), args.text("url"), args.headers(), args.strings("login"), args.strings("uncertain"), args.number("now"), args.number("from"), args.number("until")).get()) }
    }
    AsyncFunction("publish") { lease: String, job: String, candidate: String -> owner.publish(lease, job, candidate) }
    AsyncFunction("queryRequest") { args: Map<String, Any?>, promise: Promise ->
      workers.execute { promise.resolve(owner.read(args.text("lease"), args.text("generation"), args.text("job")) { it.query(args.strings("ids"), args.number("at"), args.text("mode"), args.number("from"), args.number("until"), args.number("after")) }.get()) }
    }
    AsyncFunction("current") { lease: String, generation: String, job: String, at: Double, promise: Promise ->
      workers.execute { promise.resolve(owner.read(lease, generation, job) { it.current(at.toLong()) }.get()) }
    }
    AsyncFunction("search") { lease: String, generation: String, job: String, ids: List<String>, words: List<String>, at: Double, limit: Int, promise: Promise ->
      workers.execute { promise.resolve(owner.read(lease, generation, job) { it.search(ids, words, at.toLong(), limit) }.get()) }
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
