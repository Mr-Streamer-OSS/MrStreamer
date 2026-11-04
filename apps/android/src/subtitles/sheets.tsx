import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import {
  DEFAULT_SUBTITLE_TIMING,
  type SubtitleTiming,
} from "@mrstreamer/contracts/online-subtitles";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../live/catalogue.ts";
import { SheetRow, TextButton } from "../live/chrome.tsx";
import { useStore } from "../platform/store.ts";
import { t as playerT } from "../player/copy.ts";
import { PlayerDialog } from "../player/dialog.tsx";
import type { Playing } from "../player/player.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import type { IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { FRAME_RATES, TIMING_STEPS, type SubtitleModel } from "./model.ts";
import type { SubtitleFailureReason } from "./service.ts";

// Paper A's online subtitles in Watch ("Android online subtitles"): the downloaded subtitle, Find
// online and Adjust timing under the Subtitles sheet's file tracks, the Online subtitles, Adjust
// timing and Frame rate sheets, and the dialogs for a missing or refused key and what failed.
// Ticks follow the model's state, which follows what the player reports; no key, provider
// address or path is ever shown.

/** The sheets Watch opens from the Subtitles sheet, in its one media sheet. */
export type SubtitleSheet = "online" | "timing" | "frame-rate";

const TITLES = {
  online: "Online subtitles",
  timing: "Adjust timing",
  "frame-rate": "Frame rate",
} as const satisfies Record<SubtitleSheet, string>;

export const isSubtitleSheet = (sheet: string | null): sheet is SubtitleSheet =>
  sheet !== null && Object.hasOwn(TITLES, sheet);

export const subtitleSheetTitle = (sheet: SubtitleSheet) => t(TITLES[sheet]);

/** What raises the cue while timing shows, and where it sits otherwise. */
const RESTING_INSET = 0.08;

/**
 * Below the Subtitles sheet's file tracks and a hairline: the subtitle downloaded for this exact
 * version, ticked while the player reports it showing, then Find online for a movie or episode,
 * then Adjust timing with the current timing while the downloaded one shows.
 */
export function DownloadedRows({
  model,
  choose,
  onOpen,
}: {
  model: SubtitleModel;
  choose: (run: () => Promise<boolean>) => () => void;
  onOpen: (sheet: SubtitleSheet) => void;
}) {
  const state = useStore(model.state);
  const { saved } = state;
  const subtitle = saved?.subtitle;

  if (!subtitle && !state.title) return null;

  return (
    <View style={{ borderTopWidth: 1, borderColor: colors.raised }}>
      {subtitle ? (
        <TwoLineRow
          role="radio"
          icon={state.shown ? "check" : undefined}
          selected={state.shown}
          title={languageName(subtitle.language) ?? subtitle.language}
          detail={[subtitle.hearingImpaired ? t("Hearing impaired") : null, subtitle.release]
            .filter(Boolean)
            .join(" · ")}
          trailing={t("Downloaded")}
          onPress={choose(() => model.show())}
        />
      ) : null}
      {state.title ? (
        <SheetRow
          icon="search"
          label={t("Find online")}
          trailing="SubDL"
          onPress={() => {
            void model.find();
            onOpen("online");
          }}
        />
      ) : null}
      {saved?.subtitle && state.shown ? (
        <SheetRow
          icon="timer"
          label={t("Adjust timing")}
          trailing={timingName(saved.timing)}
          onPress={() => onOpen("timing")}
        />
      ) : null}
    </View>
  );
}

/** The Online subtitles, Adjust timing or Frame rate sheet's content, under its handle. */
export function SubtitleSheetContent({
  open,
  now,
  model,
  onOpen,
  onClose,
}: {
  open: SubtitleSheet;
  now: Playing;
  model: SubtitleModel;
  onOpen: (sheet: SubtitleSheet) => void;
  onClose: () => void;
}) {
  useLocale();

  if (open === "online") return <Online now={now} model={model} onClose={onClose} />;

  return (
    <Raised model={model}>
      {open === "timing" ? (
        <Timing model={model} onOpen={onOpen} />
      ) : (
        <FrameRate model={model} onOpen={onOpen} />
      )}
    </Raised>
  );
}

/**
 * Searching, then SubDL's results in the languages searched, each with its release and format,
 * and one grey line counting those this player can't show. A tapped result reads Downloading
 * until it is kept, which closes the sheet; a failure closes it for its dialog.
 */
function Online({
  now,
  model,
  onClose,
}: {
  now: Playing;
  model: SubtitleModel;
  onClose: () => void;
}) {
  const state = useStore(model.state);

  useEffect(() => {
    if (state.error) onClose();
  }, [state.error, onClose]);

  const names = state.languages.map((code) => languageName(code) ?? code);

  if (state.phase === "searching")
    return (
      <>
        <Header title={t("Online subtitles")} />
        <TwoLineRow
          title={t("Searching SubDL")}
          detail={t("{title}, in {languages}", { title: now.intent.title, languages: list(names) })}
        />
      </>
    );

  const formats = [...new Set(state.unsupported)].map((format) =>
    format === "Unknown" ? t("unknown format") : format.toUpperCase(),
  );

  return (
    <>
      <Header title={t("Online subtitles")} trailing={names.join(" · ")} />
      {state.results.map((result) => {
        const downloading = state.downloading === result.id;
        const language = languageName(result.language) ?? result.language;

        return (
          <TwoLineRow
            key={result.id}
            title={result.hearingImpaired ? `${language} · ${t("Hearing impaired")}` : language}
            detail={result.release}
            trailing={downloading ? t("Downloading") : result.format}
            active={downloading}
            onPress={() =>
              void model.choose(result.id).then((kept) => {
                if (kept) onClose();
              })
            }
          />
        );
      })}
      {!state.results.length && !formats.length ? (
        <TwoLineRow
          title={t("No subtitles found")}
          detail={t("SubDL has none for this in your languages.")}
        />
      ) : null}
      {formats.length ? (
        <Line>
          {t("Can't show here: {count} results in {formats}.", {
            count: state.unsupported.length,
            formats: formats.join(", "),
          })}
        </Line>
      ) : null}
    </>
  );
}

/**
 * Raises the player's own cues above the timing sheet while it shows, so the line being tuned
 * stays readable, and puts them back as it closes (PiP closes it too).
 */
function Raised({ model, children }: { model: SubtitleModel; children: ReactNode }) {
  const { height } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const [content, setContent] = useState(0);

  useEffect(() => {
    // The handle's band, the sheet's foot and 12dp of air above it.
    if (content) void model.inset(Math.min(0.8, (content + 36 + 8 + bottom + 12) / height));
  }, [model, content, height, bottom]);

  useEffect(() => () => void model.inset(RESTING_INSET), [model]);

  return <View onLayout={(event) => setContent(event.nativeEvent.layout.height)}>{children}</View>;
}

/** Steps of 1 s and 0.1 s, Frame rate, Reset once changed. Each applies at once. */
function Timing({
  model,
  onOpen,
}: {
  model: SubtitleModel;
  onOpen: (sheet: SubtitleSheet) => void;
}) {
  const timing = useStore(model.state).saved?.timing ?? DEFAULT_SUBTITLE_TIMING;
  const changed = timing.offset !== 0 || timing.speed !== 1;

  return (
    <>
      <Header title={t("Adjust timing")} trailing={timingName(timing)} strong />
      <View
        style={{ minHeight: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }}
      >
        {TIMING_STEPS.map((step, index) => (
          <Step
            key={step}
            label={
              step < 0
                ? t("{seconds} s earlier", { seconds: -step })
                : t("{seconds} s later", { seconds: step })
            }
            divided={index > 0}
            onPress={() => void model.shift(step)}
          />
        ))}
      </View>
      <PlainRow
        label={t("Frame rate")}
        trailing={frameRateName(timing.speed)}
        next
        onPress={() => onOpen("frame-rate")}
      />
      {changed ? <PlainRow label={t("Reset")} onPress={() => void model.reset()} /> : null}
      <View style={{ minHeight: 40, justifyContent: "center", paddingHorizontal: 24 }}>
        <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
          {t("Kept with this subtitle for this version, offline too.")}
        </Text>
      </View>
    </>
  );
}

/** Original and the six conversions, ticked on the one kept; choosing goes back to timing. */
function FrameRate({
  model,
  onOpen,
}: {
  model: SubtitleModel;
  onOpen: (sheet: SubtitleSheet) => void;
}) {
  const timing = useStore(model.state).saved?.timing ?? DEFAULT_SUBTITLE_TIMING;

  return (
    <>
      <Header title={t("Frame rate")} trailing={t("Subtitle fps → video fps")} />
      {FRAME_RATES.map((rate) => {
        const ticked = same(rate.speed, timing.speed);

        return (
          <SheetRow
            key={rate.label}
            role="radio"
            icon={ticked ? "check" : undefined}
            selected={ticked}
            label={rate.speed === 1 ? t("Original") : rate.label}
            onPress={() => {
              void model.timing({ ...timing, speed: rate.speed });
              onOpen("timing");
            }}
          />
        );
      })}
    </>
  );
}

/**
 * What failed, over Watch: a missing key opens the key dialog and Save and search searches with
 * it, a refused key offers Replace key, an unreadable result offers Other results and a refused
 * save Try again. The rest are iOS's words with OK. While timing shows, a refusal keeps the
 * previous timing.
 */
export function SubtitleDialog({
  model,
  sheet,
  onOpen,
}: {
  model: SubtitleModel;
  sheet: string | null;
  onOpen: (sheet: SubtitleSheet) => void;
}) {
  useLocale();
  const state = useStore(model.state);
  const [asking, setAsking] = useState(false);

  if (asking)
    return (
      <KeyDialog
        submit={t("Save and search")}
        onSave={async (key) => {
          if (!(await model.saveKey(key))) {
            // The dialog says so itself, and keeps what was typed for another try.
            model.dismissError();

            return false;
          }

          setAsking(false);
          void model.find();
          onOpen("online");

          return true;
        }}
        onClose={() => setAsking(false)}
      />
    );

  if (!state.error) return null;

  const said = words(state.error, {
    timing: sheet === "timing" || sheet === "frame-rate",
    shown: state.shown,
    results: state.results.length > 0,
  });

  const dismiss = () => model.dismissError();

  const act = () => {
    dismiss();

    if (said.action?.run === "key") setAsking(true);
    else if (said.action?.run === "results") onOpen("online");
    else void model.retry();
  };

  return (
    <PlayerDialog
      title={said.title}
      body={said.body}
      closeLabel={said.action ? playerT("Cancel") : playerT("OK")}
      onClose={dismiss}
      actions={
        said.action ? (
          <>
            <TextButton label={playerT("Cancel")} strong onPress={dismiss} />
            <TextButton label={said.action.label} strong onPress={act} />
          </>
        ) : (
          <TextButton label={playerT("OK")} strong onPress={dismiss} />
        )
      }
    />
  );
}

/** A failure's title, body and the action besides Cancel, when it has one; else OK. */
function words(
  error: SubtitleFailureReason,
  { timing, shown, results }: { timing: boolean; shown: boolean; results: boolean },
): {
  title: string;
  body: string;
  action?: { label: string; run: "key" | "results" | "retry" } | undefined;
} {
  if (timing && (error === "timing" || error === "not-saved"))
    return { title: t("Couldn't change timing"), body: t("The previous timing is kept.") };

  switch (error) {
    case "timing-limit":
      return {
        title: t("Timing limit reached"),
        body: t("Timing can change by up to 600 seconds."),
      };
    case "selection-save":
      return {
        title: t("Couldn’t keep the subtitle choice"),
        body: t("The previous choice is kept. Try again."),
        action: { label: t("Try again"), run: "retry" },
      };
    case "not-configured":
      return {
        title: t("SubDL key needed"),
        body: t("Find online searches SubDL with your own API key. It stays sealed on this phone."),
        action: { label: t("Add key"), run: "key" },
      };
    case "credentials":
      return {
        title: t("SubDL refused the key"),
        body: t("Check your SubDL API key. Nothing was searched."),
        action: { label: t("Replace key"), run: "key" },
      };
    case "quota":
      return {
        title: t("SubDL limit reached"),
        body: t("Your SubDL key has no requests left for now. Try again later."),
      };
    case "unavailable":
      return {
        title: t("SubDL isn't available"),
        body: shown
          ? `${t("Check your connection and try again.")} ${t("The downloaded subtitle still shows.")}`
          : t("Check your connection and try again."),
      };
    case "unsupported":
      return {
        title: t("Can't use this subtitle"),
        body: t("It isn't text the app can read. Try another."),
        // Other results only while there are others to show.
        action: results ? { label: t("Other results"), run: "results" } : undefined,
      };
    case "keychain":
      return {
        title: t("Couldn't read your SubDL key"),
        body: t("This phone didn't give it. Try again."),
      };
    case "not-saved":
      return {
        title: t("Couldn't keep this subtitle"),
        body: t("This phone refused to save it, so it isn't shown. Try again."),
        action: { label: t("Try again"), run: "retry" },
      };
    case "read":
      return {
        title: t("Couldn't read the downloaded subtitle"),
        body: t("It wasn't changed. Try again."),
        action: { label: t("Try again"), run: "retry" },
      };
    case "timing":
      return {
        title: playerT("Couldn't show subtitles"),
        body: playerT("This phone refused the change. Try again."),
      };
  }
}

/**
 * Asks for the whole SubDL key, masked unless the eye shows it, and never fills in one saved.
 * `onSave` answers whether the key was kept; when it wasn't, the dialog says so and stays open.
 */
export function KeyDialog({
  submit,
  onSave,
  onClose,
}: {
  submit: string;
  onSave: (key: string) => Promise<boolean>;
  onClose: () => void;
}) {
  useLocale();
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const eye = useKeyboardFocus();

  const save = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    const kept = await onSave(value);
    setBusy(false);
    setRefused(!kept);
  };

  return (
    <PlayerDialog
      title={t("SubDL API key")}
      closeLabel={playerT("Cancel")}
      onClose={onClose}
      actions={
        <>
          <TextButton label={playerT("Cancel")} strong onPress={onClose} />
          <TextButton label={submit} strong onPress={() => void save()} />
        </>
      }
    >
      <View style={{ gap: 4 }}>
        <View
          style={{
            minHeight: 56,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingLeft: 14,
            paddingRight: 6,
            borderWidth: 2,
            borderRadius: 4,
            borderColor: colors.text,
          }}
        >
          <TextInput
            accessibilityLabel={t("API key")}
            value={value}
            onChangeText={(next) => {
              setValue(next);
              setRefused(false);
            }}
            secureTextEntry={!visible}
            maxLength={4096}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            returnKeyType="go"
            onSubmitEditing={() => void save()}
            editable={!busy}
            selectionColor={colors.text}
            style={{
              flex: 1,
              paddingVertical: 8,
              color: colors.text,
              fontSize: 16,
              lineHeight: 20,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={visible ? t("Hide key") : t("Show key")}
            onPress={() => setVisible((shown) => !shown)}
            {...eye.handlers}
            android_ripple={{ color: colors.ripple, borderless: true, radius: 20 }}
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: eye.focused ? colors.focus : undefined,
            }}
          >
            <MaterialIcons
              importantForAccessibility="no-hide-descendants"
              name={visible ? "visibility-off" : "visibility"}
              size={24}
              color={colors.secondary}
            />
          </Pressable>
          <View
            importantForAccessibility="no-hide-descendants"
            style={{
              position: "absolute",
              left: 10,
              top: -9,
              paddingHorizontal: 4,
              backgroundColor: colors.surface,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 12, lineHeight: 16 }}>{t("API key")}</Text>
          </View>
        </View>
        <Text
          accessibilityLiveRegion={refused ? "polite" : "none"}
          style={{
            paddingHorizontal: 16,
            color: refused ? colors.failure : colors.secondary,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {refused
            ? t("Couldn't save the key. This phone refused it.")
            : t("From your account on subdl.com.")}
        </Text>
      </View>
    </PlayerDialog>
  );
}

/** "Shown 0.4 s later · 25 → 23.976 fps", or "Original timing" when neither changed. */
function timingName(timing: SubtitleTiming): string {
  const offset =
    timing.offset < 0
      ? t("Shown {seconds} s earlier", { seconds: -timing.offset })
      : timing.offset > 0
        ? t("Shown {seconds} s later", { seconds: timing.offset })
        : null;

  const rate = timing.speed === 1 ? null : frameRateName(timing.speed);

  return [offset, rate].filter(Boolean).join(" · ") || t("Original timing");
}

/** "Original", or the conversion kept: "25 → 23.976 fps". */
function frameRateName(speed: number): string {
  const rate = FRAME_RATES.find((each) => same(each.speed, speed));

  return !rate || rate.speed === 1 ? t("Original") : rate.label;
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** "Nederlands and English", "Nederlands, Deutsch and English". */
function list(names: readonly string[]): string {
  const last = names.at(-1);

  if (names.length < 2 || last === undefined) return last ?? "";

  return t("{list} and {last}", { list: names.slice(0, -1).join(", "), last });
}

/** A sheet's 16sp bold heading on its 48dp band, with what it shows at the end. */
function Header({
  title,
  trailing,
  strong = false,
}: {
  title: string;
  trailing?: string | undefined;
  strong?: boolean;
}) {
  return (
    <View
      style={{
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        paddingHorizontal: 24,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ flex: 1, color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}
      >
        {title}
      </Text>
      {trailing ? (
        <Text
          style={{
            color: strong ? colors.text : colors.secondary,
            fontSize: 14,
            lineHeight: 18,
            fontWeight: strong ? "500" : "400",
          }}
        >
          {trailing}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A 64dp row with a second grey line: the downloaded subtitle and SubDL's results. Its 24dp icon
 * slot keeps the sheet's lane; `active` fills it and whitens its trailing word (Downloading).
 * Without `onPress` it only says something (Searching SubDL).
 */
function TwoLineRow({
  icon,
  title,
  detail,
  trailing,
  active = false,
  selected = false,
  role = "button",
  onPress,
}: {
  icon?: IconName | undefined;
  title: string;
  detail: string;
  trailing?: string | undefined;
  active?: boolean;
  selected?: boolean;
  role?: "button" | "radio";
  onPress?: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();
  const label = [title, detail, trailing].filter(Boolean).join(", ");

  const content = (
    <>
      <View style={{ width: 24, flexShrink: 0 }}>
        {icon ? (
          <MaterialIcons
            importantForAccessibility="no-hide-descendants"
            name={icon}
            size={24}
            color={colors.text}
          />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2, paddingVertical: 8 }}>
        <Text
          style={{
            color: colors.text,
            fontSize: 16,
            lineHeight: 20,
            fontWeight: selected ? "500" : "400",
          }}
        >
          {title}
        </Text>
        <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>{detail}</Text>
      </View>
      {trailing ? (
        <Text
          style={{
            flexShrink: 0,
            color: active ? colors.text : colors.secondary,
            fontSize: 14,
            lineHeight: 18,
            fontWeight: active ? "500" : "400",
          }}
        >
          {trailing}
        </Text>
      ) : null}
    </>
  );

  const style = {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    minHeight: 64,
    paddingHorizontal: 24,
  } as const;

  if (!onPress)
    return (
      <View accessible accessibilityLabel={label} style={style}>
        {content}
      </View>
    );

  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={role === "radio" ? { checked: selected } : undefined}
      accessibilityLabel={label}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        ...style,
        backgroundColor: focused ? colors.focus : active ? colors.raised : undefined,
      }}
    >
      {content}
    </Pressable>
  );
}

/** A 56dp row on the sheet's margin with no icon lane: Frame rate and Reset. */
function PlainRow({
  label,
  trailing,
  next = false,
  onPress,
}: {
  label: string;
  trailing?: string;
  next?: boolean;
  onPress: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={trailing ? `${label}, ${trailing}` : label}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 56,
        paddingHorizontal: 24,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Text style={{ flex: 1, color: colors.text, fontSize: 16, lineHeight: 20 }}>{label}</Text>
      {trailing ? (
        <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>{trailing}</Text>
      ) : null}
      {next ? (
        <MaterialIcons
          importantForAccessibility="no-hide-descendants"
          name="chevron-right"
          size={24}
          color={colors.secondary}
        />
      ) : null}
    </Pressable>
  );
}

/** One of the four timing steps: A's flat 48dp text action, a hairline before all but the first. */
function Step({
  label,
  divided,
  onPress,
}: {
  label: string;
  divided: boolean;
  onPress: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flex: 1,
        minHeight: 48,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 4,
        borderLeftWidth: divided ? 1 : 0,
        borderColor: colors.raised,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Text
        style={{
          color: colors.text,
          fontSize: 14,
          lineHeight: 18,
          fontWeight: "700",
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A sheet's grey line under its rows, on the label's lane. */
function Line({ children }: { children: string }) {
  return (
    <View
      style={{
        minHeight: 48,
        justifyContent: "center",
        paddingLeft: 64,
        paddingRight: 24,
        paddingVertical: 8,
      }}
    >
      <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>{children}</Text>
    </View>
  );
}
