// Nothing this app keeps is backed up or moved to another phone: logins are sealed with a key that
// never leaves this one, and the list of sources without them would only ask for each login again.
// `allowBackup: false` (app.json) covers Android 11 and earlier; from Android 12 a device-to-device
// transfer ignores it and reads these rules, which exclude every domain from both.
const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

const DOMAINS = ["root", "file", "database", "sharedpref", "external"];
const excluded = (section) =>
  [
    `  <${section}>`,
    // Each domain and its device_ form; Android has no device_external.
    ...DOMAINS.flatMap((domain) =>
      domain === "external" ? [domain] : [domain, `device_${domain}`],
    ).map((domain) => `    <exclude domain="${domain}" path="." />`),
    `  </${section}>`,
  ].join("\n");
const RULES = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<data-extraction-rules>",
  excluded("cloud-backup"),
  excluded("device-transfer"),
  "</data-extraction-rules>",
  "",
].join("\n");

module.exports = (config) =>
  withDangerousMod(
    withAndroidManifest(config, (manifest) => {
      const application = manifest.modResults.manifest.application?.[0];
      if (application) {
        application.$["android:dataExtractionRules"] = "@xml/data_extraction_rules";
        application.$["android:fullBackupContent"] = "false";
      }
      return manifest;
    }),
    [
      "android",
      (project) => {
        const folder = path.join(project.modRequest.platformProjectRoot, "app/src/main/res/xml");
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, "data_extraction_rules.xml"), RULES);
        return project;
      },
    ],
  );
