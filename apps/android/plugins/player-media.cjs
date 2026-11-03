const { withAndroidManifest, withMainActivity } = require("expo/config-plugins");

module.exports = (config) => {
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const permissions = (manifest["uses-permission"] ??= []);

    for (const name of [
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_MEDIA_PLAYBACK",
      "POST_NOTIFICATIONS",
    ]) {
      const value = `android.permission.${name}`;

      if (!permissions.some((entry) => entry.$["android:name"] === value))
        permissions.push({ $: { "android:name": value } });
    }

    const app = manifest.application[0];
    const activity = app.activity.find((entry) => entry.$["android:name"] === ".MainActivity");
    activity.$["android:supportsPictureInPicture"] = "true";
    activity.$["android:resizeableActivity"] = "true";
    const services = (app.service ??= []);

    if (
      !services.some(
        (entry) => entry.$["android:name"] === "app.mrstreamer.player.PlayerMediaService",
      )
    ) {
      services.push({
        $: {
          "android:name": "app.mrstreamer.player.PlayerMediaService",
          "android:exported": "false",
          "android:foregroundServiceType": "mediaPlayback",
        },
        "intent-filter": [
          { action: [{ $: { "android:name": "androidx.media3.session.MediaSessionService" } }] },
        ],
      });
    }

    return mod;
  });

  return withMainActivity(config, (mod) => {
    const marker = "  // player-media lifecycle";

    if (!mod.modResults.contents.includes(marker)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        "    super.onCreate(null)",
        "    super.onCreate(null)\n    app.mrstreamer.player.PlayerPip.attach(this)",
      );

      const hooks = `
${marker}
  override fun onUserLeaveHint() { super.onUserLeaveHint(); app.mrstreamer.player.PlayerPip.home() }
  override fun onPictureInPictureModeChanged(inPip: Boolean, config: android.content.res.Configuration) {
    super.onPictureInPictureModeChanged(inPip, config)
    app.mrstreamer.player.PlayerPip.mode(inPip)
  }
  override fun onStop() { super.onStop(); app.mrstreamer.player.PlayerPip.stopped(this) }
  override fun onDestroy() { app.mrstreamer.player.PlayerPip.detach(this); super.onDestroy() }
`;

      const end = mod.modResults.contents.lastIndexOf("}");
      mod.modResults.contents =
        mod.modResults.contents.slice(0, end) + hooks + mod.modResults.contents.slice(end);
    }

    return mod;
  });
};
