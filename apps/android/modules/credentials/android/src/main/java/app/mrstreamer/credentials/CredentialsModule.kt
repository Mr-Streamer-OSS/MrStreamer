package app.mrstreamer.credentials

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** [Credentials] for the app's JS, off the JS thread: src/platform/credentials.ts. */
class CredentialsModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("Credentials")
    AsyncFunction("read") { id: String -> Credentials.read(context, id) }
    AsyncFunction("write") { id: String, secret: String -> Credentials.write(context, id, secret) }
    AsyncFunction("remove") { id: String -> Credentials.remove(context, id) }
    AsyncFunction("retain") { ids: List<String> -> Credentials.retain(context, ids) }
  }
}
