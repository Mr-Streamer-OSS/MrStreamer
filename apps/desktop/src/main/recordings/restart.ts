// An update's install, as the app's restart into it waits on recordings.
import { t } from "@mrstreamer/core/i18n";
import type { Installer } from "../services/updates.ts";

/**
 * `installer`, whose restart quits without asking: `confirm` says so as it installs, and takes
 * that back when the system refuses the release and the app goes on. First it refuses the install
 * itself, with the reason Settings shows, while `stopsKept` (`Recordings.keepStops`) answers that
 * a recording the viewer stopped isn't kept as stopped, which the relaunch would go on with.
 */
export function installingOnceStopsKept(
  installer: Installer,
  stopsKept: () => Promise<boolean>,
  confirm: (confirmed: boolean) => void,
): Installer {
  return {
    ...installer,
    install: async () => {
      if (!(await stopsKept()))
        throw new Error(
          t(
            "A recording you stopped couldn't be saved as stopped. Check its storage, then try again.",
          ),
        );
      confirm(true);
      try {
        return await installer.install();
      } catch (cause) {
        confirm(false);
        throw cause;
      }
    },
  };
}
