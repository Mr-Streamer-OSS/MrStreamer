import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../live/catalogue.ts";
import { SheetTitle } from "../live/chrome.tsx";
import { useStore } from "../platform/store.ts";
import { Note, Row, Section, SheetAction, type SnackbarMessage } from "../settings/parts.tsx";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { KeyDialog } from "./sheets.tsx";
import {
  readSubtitleTextSize,
  setSubtitleTextSize,
  subtitles,
  subtitleTextSize,
  subtitleTextSizeError,
} from "./runtime.ts";

/** Text size's choices, as iOS names them, by their scale of the player's cue size. */
const SIZES = [
  { name: "Small", scale: 0.8 },
  { name: "Medium", scale: 1 },
  { name: "Large", scale: 1.3 },
] as const;

/**
 * Paper A's Subtitles group in Settings, between Media and TMDB: the SubDL API key, only ever
 * Saved or Not set, whose Replace asks for the whole key again and whose Remove keeps downloaded
 * subtitles, and Text size for all subtitles. A read or write this phone refused is
 * `notify`'d as the Settings screen's snackbar with Try again. Insertion is pending the Settings handoff.
 */
export function SubtitleSettingsSection({
  notify,
}: {
  notify: (message: SnackbarMessage) => void;
}) {
  useLocale();
  const model = subtitles();
  const state = useStore(model.state);
  const size = useStore(subtitleTextSize);
  const sizeError = useStore(subtitleTextSizeError);
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<"actions" | "key" | "size" | null>(null);

  const retry = useCallback(
    (text: string, run: () => void) => notify({ text, action: { label: t("Try again"), run } }),
    [notify],
  );

  const readKey = useCallback(async () => {
    await model.readKey();

    if (model.state.get().error !== "keychain") return;
    model.dismissError();
    retry(t("Couldn't read your SubDL key"), () => void readKey());
  }, [model, retry]);

  const readSize = useCallback(() => {
    if (!readSubtitleTextSize()) retry(t("Couldn't read the text size."), readSize);
  }, [retry]);

  useEffect(() => {
    void readKey();
    readSize();
  }, [readKey, readSize]);

  const saveKey = async (key: string) => {
    setOpen(null);

    if (await model.saveKey(key)) return;
    model.dismissError();
    retry(t("Couldn't save the key. This phone refused it."), () => void saveKey(key));
  };

  const removeKey = async () => {
    setOpen(null);

    if (await model.removeKey()) return;
    model.dismissError();
    retry(t("Couldn't remove the key. This phone refused it."), () => void removeKey());
  };

  const chooseSize = (scale: number) => {
    setOpen(null);

    if (!setSubtitleTextSize(scale))
      retry(t("Couldn't save the text size. This phone refused it."), () => chooseSize(scale));
  };

  const sizeName = SIZES.reduce((near, each) =>
    Math.abs(each.scale - size) < Math.abs(near.scale - size) ? each : near,
  ).name;

  return (
    <Section name={t("Subtitles")}>
      <Row
        label={t("SubDL API key")}
        value={
          state.keySaved === null ? t("Not known") : state.keySaved ? t("Saved") : t("Not set")
        }
        onPress={() => setOpen(state.keySaved ? "actions" : "key")}
      />
      <Row
        label={t("Text size")}
        value={sizeError ? t("Not known") : t(sizeName)}
        onPress={() => setOpen("size")}
      />
      <View style={{ paddingTop: 4, paddingBottom: 8 }}>
        <Note>
          {t(
            "Find online in Watch searches SubDL with your own key, which stays sealed on this phone. Text size applies to all subtitles.",
          )}
        </Note>
      </View>
      <Sheet
        visible={open === "actions" || open === "size"}
        label={open === "size" ? t("Text size") : t("SubDL API key")}
        onClose={() => setOpen(null)}
        fit
      >
        <View style={{ paddingBottom: insets.bottom + 24 }}>
          {open === "size" ? (
            <>
              <SheetTitle>{t("Text size")}</SheetTitle>
              {SIZES.map((each) => (
                <SheetAction
                  key={each.name}
                  icon={!sizeError && each.name === sizeName ? "check" : null}
                  label={t(each.name)}
                  primary={!sizeError && each.name === sizeName}
                  selected={!sizeError && each.name === sizeName}
                  onPress={() => chooseSize(each.scale)}
                />
              ))}
            </>
          ) : (
            <>
              <SheetTitle>{t("SubDL API key")}</SheetTitle>
              <SheetAction icon="edit" label={t("Replace")} onPress={() => setOpen("key")} />
              <SheetAction icon="delete" label={t("Remove")} onPress={() => void removeKey()} />
              <Text
                style={{
                  paddingTop: 8,
                  paddingLeft: 64,
                  paddingRight: 24,
                  color: colors.secondary,
                  fontSize: 14,
                  lineHeight: 18,
                }}
              >
                {t("Replace asks for the whole key again. Downloaded subtitles stay either way.")}
              </Text>
            </>
          )}
        </View>
      </Sheet>
      {open === "key" ? (
        <KeyDialog
          submit={t("Save")}
          onSave={(key) => {
            // It closes at once; a refusal comes back as the snackbar.
            void saveKey(key);

            return Promise.resolve(true);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </Section>
  );
}
