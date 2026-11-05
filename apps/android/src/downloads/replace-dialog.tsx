import { useIsFocused } from "expo-router";
import { Text, View } from "react-native";
import { Dialog, RED, TextButton } from "../live/chrome.tsx";
import { useStore } from "../platform/store.ts";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { named, replaceNow, type ReplaceOwner } from "./replace.ts";

/** The body text of Paper A's sheets and dialogs, a step under white. */
export const BODY = "#D4D4D4";

/** A dialog's 14sp body in Paper A's light grey. */
export function Body({ children }: { children: string }) {
  return (
    <Text style={{ paddingTop: 16, color: BODY, fontSize: 14, lineHeight: 20 }}>{children}</Text>
  );
}

/** The prompt over the focused screen; Details and Downloads each show it while on top. */
export function ReplaceDialog({ owner }: { owner: ReplaceOwner }) {
  const prompt = useStore(owner.prompt);
  const focused = useIsFocused();

  if (!prompt || !focused) return null;
  const close = () => owner.prompt.set(null);
  const { name, episode } = named(prompt.row);

  switch (prompt.kind) {
    case "confirm":
      return (
        <Dialog
          title={t("Replace the copy of {name}?", { name })}
          onClose={close}
          actions={
            <View style={{ width: "100%", alignItems: "flex-end" }}>
              <TextButton
                label={t("Replace")}
                strong
                color={RED}
                onPress={() => {
                  close();
                  replaceNow(owner, prompt.row);
                }}
              />
              <TextButton label={t("Cancel")} color={colors.text} onPress={close} />
            </View>
          }
        >
          <Body>
            {t(
              "Its file changed on this device. Replacing deletes it and downloads {episode} again in the same version.",
              { episode },
            )}
          </Body>
        </Dialog>
      );
    case "refused":
      return (
        <Dialog
          title={t("Couldn't remove {name}", { name })}
          onClose={close}
          actions={<TextButton label={t("OK")} strong onPress={close} />}
        >
          <Body>
            {t(
              prompt.reason === "playing"
                ? "Stop playing this copy first."
                : "The old copy is still closing. Try again.",
            )}
          </Body>
        </Dialog>
      );
    case "failed":
      return (
        <Dialog
          title={t("Couldn't save that change.")}
          onClose={close}
          actions={<TextButton label={t("OK")} strong onPress={close} />}
        />
      );
  }
}
