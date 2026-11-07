import { updatesInApp } from "@mrstreamer/contracts/updates";
import { distributionLabel } from "../updates/distribution.ts";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as KeyPress,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t } from "@mrstreamer/core/i18n";
import { isTyping } from "../../app/platform.ts";
import {
  shortcutBinding,
  shortcutBindings,
  shortcutCommands,
  validateShortcut,
  type ShortcutCommand,
  type ShortcutOverrides,
} from "../../app/shortcuts.ts";
import { currentPreferences, updatePreferences } from "../../lib/preferences.ts";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { cn } from "../../lib/utils.ts";
import { call } from "../../lib/ipc.ts";
import { Message } from "../../lib/message.tsx";
import tmdbLogo from "../../assets/tmdb.svg";
import { CustomizeHome } from "../home/CustomizeHome.tsx";
import {
  GeneralSection,
  PlaybackSection,
  LiveSettingsSection,
  MoviesSettingsSection,
  SubtitlesSettingsSection,
  PrivacySection,
} from "./GeneralSection.tsx";
import { UpdatesSection } from "../updates/UpdatesSection.tsx";
import { SearchField } from "../../components/ui/search-field.tsx";
import { queries } from "../../lib/queries.ts";
import { SaveFeedback } from "./SaveFeedback.tsx";
import {
  SETTINGS_SECTIONS,
  findSettings,
  settingSection,
  type SettingsControl,
  type SettingsSection,
} from "./catalogue.ts";
import { GuidesSection } from "./GuidesSection.tsx";
import { RecordingsSection } from "./RecordingsSection.tsx";
import { DiagnosticsExport } from "./DiagnosticsExport.tsx";
import { Licences } from "./Licences.tsx";
import { SubscriptionSection } from "./SubscriptionSection.tsx";
import { useUpdates } from "../updates/use-updates.ts";

const REPOSITORY_URL = "https://github.com/Mr-Streamer-OSS/MrStreamer";
const PRIVACY_URL = "https://mrstreamer.app/privacy";

const CONTROL_SELECTOR =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [data-setting-focus]";

/**
 * Settings, a page over the current view, so a channel keeps playing underneath. Opens with ⌘,
 * or Ctrl , on the tab its opener asks for. Back in the top bar, or Escape, returns to the view;
 * a dialog over the page closes first.
 */
export function SettingsPage() {
  const tab = useUi((state) => state.settings);
  const target = useUi((state) => state.settingsTarget);
  const legacyOnline = useUi((state) => state.onlineSubtitles);
  const [query, setQuery] = useState("");
  const [visited, setVisited] = useState<ReadonlySet<SettingsSection>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const opened = useRef(false);
  const preferences = useQuery(queries.preferences());
  const updates = useQuery(queries.updates());
  const shownTab = tab === "licences" ? "about" : tab;

  useEffect(
    () =>
      useUi.subscribe((state, previous) => {
        if (state.settings && !previous.settings) returnFocus.current = document.activeElement;
      }),
    [],
  );

  useEffect(() => {
    if (tab && !opened.current) {
      returnFocus.current ??= document.activeElement;
      opened.current = true;
      setQuery("");
      root.current?.querySelector<HTMLButtonElement>('nav button[aria-current="page"]')?.focus();
    } else if (!tab && opened.current) {
      useUi.setState({ settingsTarget: null });
      opened.current = false;
      setVisited(new Set());
      const previous = returnFocus.current;

      const fallback =
        document.querySelector<HTMLElement>('[data-view="title"], [data-view="watch"]') ??
        document.querySelector<HTMLButtonElement>(`header button[aria-label="${t("Settings")}"]`);

      const target =
        previous instanceof HTMLElement &&
        previous !== document.body &&
        previous.isConnected &&
        !previous.closest("[inert], [hidden]")
          ? previous
          : fallback;

      target?.focus();
      returnFocus.current = null;
    }

    if (shownTab) setVisited((previous) => new Set([...previous, shownTab]));
  }, [tab, shownTab]);

  useEffect(() => {
    if (legacyOnline)
      useUi.setState({
        settings: "subtitles",
        settingsTarget: "online-subtitles",
        onlineSubtitles: false,
      });
  }, [legacyOnline]);

  // Wait for an enabled control or informational destination, including a section still loading.
  useEffect(() => {
    if (!target || !tab) return;

    const focus = () => {
      const container = root.current?.querySelector(
        `[data-settings-section="${settingSection(target)}"]`,
      );

      const row = container?.querySelector(`[data-setting="${target}"]`);
      const control = row?.matches(CONTROL_SELECTOR) ? row : row?.querySelector(CONTROL_SELECTOR);

      if (!(control instanceof HTMLElement)) return false;
      control.scrollIntoView({ block: "nearest" });
      control.focus({ preventScroll: true });
      useUi.setState({ settingsTarget: null });

      return true;
    };

    if (focus()) return;

    const observer = new MutationObserver(() => {
      if (focus()) observer.disconnect();
    });

    if (root.current)
      observer.observe(root.current, { subtree: true, childList: true, attributes: true });

    return () => observer.disconnect();
  }, [target, tab, visited]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      const current = useUi.getState().settings;

      const editing =
        isTyping(event) &&
        !(event.target instanceof HTMLInputElement && event.target.type === "checkbox");

      if (!current || (editing && current !== "licences")) return;
      useUi.setState({
        settings: current === "licences" ? "about" : null,
        settingsTarget: current === "licences" ? "licences" : null,
      });
      event.preventDefault();
    }

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!tab) return null;

  const navigate = (section: SettingsSection, control?: SettingsControl) => {
    setQuery("");
    useUi.setState({
      settings: section,
      settingsTarget: control ?? null,
    });
  };

  const results = query.trim() ? findSettings(query, updates.data?.distribution) : null;

  const panels = {
    general: <GeneralSection />,
    playback: (
      <>
        <PlaybackSection />
        <KeyboardShortcuts />
      </>
    ),
    live: <LiveSettingsSection />,
    movies: <MoviesSettingsSection />,
    subtitles: <SubtitlesSettingsSection />,
    home: (
      <div data-setting="home-rows">
        <CustomizeHome />
      </div>
    ),
    subscriptions: (
      <div data-setting="subscriptions">
        <SubscriptionSection />
      </div>
    ),
    guides: (
      <div data-setting="guides">
        <GuidesSection />
      </div>
    ),
    recordings: <RecordingsSection />,
    updates: <UpdatesSection />,
    privacy: <PrivacySection />,
    about: <About />,
  } satisfies Record<SettingsSection, ReactNode>;

  return (
    <div
      ref={root}
      data-view="settings"
      className="fixed inset-0 z-40 flex flex-col bg-black text-white"
    >
      <WindowBar className="bg-black" />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("Settings")}
          className="flex w-60 max-w-[32%] flex-none flex-col border-r border-border px-3 pt-3"
        >
          <h1 className="mb-3 px-2 text-2xl font-semibold tracking-tight">{t("Settings")}</h1>
          <SearchField
            ref={search}
            type="search"
            aria-label={t("Find a setting")}
            placeholder={t("Find a setting")}
            value={query}
            className="mb-3 flex-none"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }

              if (event.key === "ArrowDown" && results?.length) {
                event.preventDefault();
                root.current?.querySelector<HTMLButtonElement>("[data-setting-result]")?.focus();
              }

              if (event.key === "Enter" && results?.[0]) {
                event.preventDefault();
                navigate(results[0].section, results[0].id);
              }
            }}
          />
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            {results ? (
              <>
                {results.length === 0 && (
                  <p role="status" className="px-2 py-3 text-sm">
                    {t("No settings found")}
                  </p>
                )}
                <button
                  className="w-full rounded-lg px-2 py-2 text-left text-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  {t("Clear search")}
                </button>
                {results.map((control) => (
                  <button
                    data-setting-result
                    key={control.id}
                    onClick={() => navigate(control.section, control.id)}
                    className="block w-full rounded-lg px-2 py-2 text-left text-sm break-words outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {t(control.label)}
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        SETTINGS_SECTIONS.find((section) => section.id === control.section)!.label,
                      )}
                    </span>
                  </button>
                ))}
              </>
            ) : (
              SETTINGS_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  aria-current={section.id === shownTab ? "page" : undefined}
                  onClick={() => navigate(section.id)}
                  className={cn(
                    "block w-full rounded-lg px-2 py-2 text-left text-[0.9375rem] break-words outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    section.id === shownTab
                      ? "bg-white/10 text-white"
                      : "text-muted-foreground hover:bg-white/5 hover:text-white",
                  )}
                >
                  {t(section.label)}
                </button>
              ))
            )}
          </div>
        </nav>
        {tab === "licences" && <Licences />}
        {SETTINGS_SECTIONS.filter(
          (section) => visited.has(section.id) || section.id === shownTab,
        ).map((section) => (
          <main
            key={section.id}
            data-settings-section={section.id}
            hidden={tab !== section.id}
            className="min-w-0 flex-1 overflow-y-auto px-6 pt-5 pb-10 lg:px-9"
          >
            <div className="max-w-[44rem]">
              {preferences.isError && (
                <div role="alert">
                  <p>{t("Settings could not be read.")}</p>
                  <SaveFeedback
                    pending={preferences.isFetching}
                    error={preferences.error}
                    retry={() => void preferences.refetch()}
                  />
                </div>
              )}
              {preferences.isPending && <p role="status">{t("Loading…")}</p>}
              {panels[section.id]}
            </div>
          </main>
        ))}
      </div>
    </div>
  );
}

type ShortcutChange =
  { command: ShortcutCommand; binding: string } | { reset: ShortcutCommand | "all" };

/** The overrides a change leaves. Commands this version doesn't know survive a single edit. */
function changedShortcuts(overrides: ShortcutOverrides, change: ShortcutChange): ShortcutOverrides {
  if ("binding" in change) return { ...overrides, [change.command]: [change.binding] };

  if (change.reset === "all") return {};

  return Object.fromEntries(Object.entries(overrides).filter(([id]) => id !== change.reset));
}

const changeTarget = (change: ShortcutChange) =>
  "reset" in change ? change.reset : change.command;

const ARROWS: Readonly<Record<string, string>> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/** A binding as its key is labelled: Space, ←, Shift K. */
function keyName(binding: string): string {
  const key = binding.replace(/^Shift\+/, "");
  const name = key === "Space" ? t("Space") : (ARROWS[key] ?? key.toUpperCase());

  return key === binding ? name : `${t("Shift")} ${name}`;
}

/** A letter bound with and without Shift runs one command, so it shows once. */
function keyNames(bindings: readonly string[]): string[] {
  return bindings.flatMap((binding) =>
    binding.startsWith("Shift+") && bindings.includes(binding.slice(6)) ? [] : [keyName(binding)],
  );
}

const commandLabel = (id: ShortcutCommand) =>
  t(shortcutCommands.find((command) => command.id === id)!.label);

/**
 * The player's keyboard reference for the viewing profile, where a command's keys are also the
 * button that changes them. The next key pressed replaces every key of that command in both
 * players; Escape cancels and Tab leaves. A save that fails keeps the committed keys shown, with
 * the same change to retry beside the row.
 */
function KeyboardShortcuts() {
  const client = useQueryClient();
  const preferences = useQuery(queries.preferences());
  const [capturing, setCapturing] = useState<ShortcutCommand | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const root = useRef<HTMLElement>(null);
  // A saved Space would otherwise click the focused button on keyup and start capturing again.
  const swallowKeyUp = useRef(false);
  const hint = useId();
  const latest = () => currentPreferences(client)?.keyboardShortcuts ?? {};

  const save = useMutation({
    mutationKey: ["settings", "keyboardShortcuts"],
    mutationFn: (change: ShortcutChange) =>
      updatePreferences({ keyboardShortcuts: changedShortcuts(latest(), change) }, client),
    onSuccess: (_, change) => {
      const target = changeTarget(change);
      setAnnouncement(
        target === "all" ? t("Reset to defaults") : `${commandLabel(target)}, ${t("Saved")}`,
      );
    },
  });

  if (!preferences.data) return null;

  const overrides = preferences.data.keyboardShortcuts ?? {};
  const busy = save.isPending;
  const change = save.variables;

  const focusKeys = (id: ShortcutCommand) =>
    root.current?.querySelector<HTMLButtonElement>(`[data-shortcut="${id}"]`)?.focus();

  const stop = () => {
    setCapturing(null);
    setRefusal(null);
  };

  const capture = (event: KeyPress, command: ShortcutCommand) => {
    if (capturing !== command || ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;

    if (event.key === "Tab") return stop();

    // App and system chords keep working; only the refusal shows.
    if (event.ctrlKey || event.metaKey || event.altKey)
      return setRefusal(t("That key is reserved. Press another key."));
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") return stop();
    const binding = shortcutBinding(event.nativeEvent);
    const problem = binding && validateShortcut(command, binding, latest());

    if (!binding || problem)
      return setRefusal(
        problem && problem.kind === "conflict"
          ? t("{key} is used by {command}. Press another key.", {
              key: keyName(binding!),
              command: commandLabel(problem.command),
            })
          : t("That key is reserved. Press another key."),
      );
    swallowKeyUp.current = true;
    stop();
    save.mutate({ command, binding });
  };

  const feedback = (target: ShortcutCommand | "all") =>
    change &&
    changeTarget(change) === target && (
      <SaveFeedback
        pending={busy}
        error={save.error}
        retryDisabled={busy}
        retry={() => save.mutate(change)}
      />
    );

  const lanes = "w-40 flex-none lg:w-50";

  return (
    <section ref={root} data-setting="keyboard-shortcuts" className="mb-10 text-[0.9375rem]">
      <div className="mb-1 flex items-baseline gap-4">
        <h2 className="flex-1 font-semibold">{t("Keyboard shortcuts")}</h2>
        <button
          aria-disabled={busy || !Object.keys(overrides).length}
          onClick={() => {
            if (!busy && Object.keys(overrides).length) save.mutate({ reset: "all" });
          }}
          className="rounded text-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:text-muted-foreground aria-disabled:no-underline"
        >
          {t("Reset all")}
        </button>
      </div>
      {feedback("all")}
      <p id={hint} className="mb-2 text-[0.8125rem] text-muted-foreground">
        {t("Select keys to change them. Escape cancels.")}
      </p>
      <div
        aria-hidden
        className="flex h-8 items-center gap-2 border-b border-white/8 text-[0.8125rem] text-muted-foreground"
      >
        <span className="min-w-0 flex-1" />
        <span className={lanes}>{t("Live TV")}</span>
        <span className={lanes}>{t("Movies and series")}</span>
        <span className="w-14 flex-none" />
      </div>
      {shortcutCommands.map((command) => {
        const live = keyNames(shortcutBindings(command.id, "live", overrides));
        const title = keyNames(shortcutBindings(command.id, "title", overrides));
        const label = t(command.label);
        const same = live.join() === title.join();

        const spoken = same
          ? live.join(", ")
          : [
              live.length ? `${t("Live TV")} ${live.join(", ")}` : "",
              title.length ? `${t("Movies and series")} ${title.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join(", ");

        const keys = (names: string[]) => (
          <span className={cn(lanes, "flex")}>
            {names.length > 0 && (
              <kbd className="inline-flex h-7 items-center gap-2.5 rounded-md border border-white/10 px-2.5 font-sans text-sm font-medium">
                {names.map((name) => (
                  <span key={name}>{name}</span>
                ))}
              </kbd>
            )}
          </span>
        );

        return (
          <div key={command.id} className="border-b border-white/8">
            <div className="flex min-h-11 items-center gap-2 py-1">
              <span className="min-w-0 flex-1 break-words">{label}</span>
              <button
                data-shortcut={command.id}
                aria-label={capturing === command.id ? label : `${label}: ${spoken}`}
                aria-describedby={hint}
                aria-disabled={busy}
                onClick={() => {
                  if (busy || capturing === command.id) return;
                  setCapturing(command.id);
                  setRefusal(null);
                  setAnnouncement(
                    t("Press a key for {command}. Escape cancels.", { command: label }),
                  );
                }}
                onKeyDown={(event) => capture(event, command.id)}
                onKeyUp={(event) => {
                  if (!swallowKeyUp.current) return;
                  swallowKeyUp.current = false;
                  event.preventDefault();
                }}
                onBlur={() => capturing === command.id && stop()}
                className="flex gap-2 rounded-md text-left outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {capturing === command.id ? (
                  <span className="flex w-82 flex-none lg:w-102">
                    <kbd className="inline-flex h-7 items-center rounded-md border-2 border-white px-2.5 font-sans text-sm font-medium">
                      {t("Press a key")}
                    </kbd>
                  </span>
                ) : (
                  <>
                    {keys(live)}
                    {keys(title)}
                  </>
                )}
              </button>
              <span className="flex w-14 flex-none justify-end">
                {overrides[command.id] && (
                  <button
                    aria-label={`${t("Reset")} ${label}`}
                    aria-disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      // The reset button leaves with the override, so focus waits on the keys.
                      focusKeys(command.id);
                      save.mutate({ reset: command.id });
                    }}
                    className="rounded text-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t("Reset")}
                  </button>
                )}
              </span>
            </div>
            {capturing === command.id && refusal && (
              <p role="alert" className="pb-2 text-[0.8125rem] text-destructive">
                {refusal}
              </p>
            )}
            {feedback(command.id)}
          </div>
        );
      })}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

/**
 * The installed version, where the project lives, the commit the build comes from, its licences,
 * the privacy policy, local diagnostics and how to report a bug or rate a Store copy.
 */
function About() {
  const { status } = useUpdates();
  const rating = useMutation({ mutationFn: () => call("updates.rateStore") });

  const rows: [string, ReactNode][] = [
    [
      t("Version"),
      status
        ? [
            status.version,
            status.channel === "nightly" ? t("Nightly") : t("Stable"),
            ...(!updatesInApp(status.distribution) ? [distributionLabel(status.distribution)] : []),
          ].join(" · ")
        : "",
    ],
    [
      t("Website"),
      <span data-setting="website">
        <Link href="https://mrstreamer.app">mrstreamer.app</Link>
      </span>,
    ],
    [
      t("Source"),
      <span data-setting="source">
        <Link href={REPOSITORY_URL}>GitHub</Link>
        {__BUILD_COMMIT__ && (
          <>
            {" · "}
            <Link href={`${REPOSITORY_URL}/tree/${__BUILD_COMMIT__}`}>
              {__BUILD_COMMIT__.slice(0, 7)}
            </Link>
          </>
        )}
        {" · GPL-3.0"}
      </span>,
    ],
    [
      t("Licences"),
      <button
        data-setting="licences"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => useUi.setState({ settings: "licences" })}
        className="underline underline-offset-4"
      >
        {t("Open-source licences")}
      </button>,
    ],
    [t("Privacy"), <Link href={PRIVACY_URL}>mrstreamer.app/privacy</Link>],
  ];

  return (
    <section>
      <Rows rows={rows} />
      <div className="flex flex-wrap gap-2">
        <Button
          data-setting="report"
          variant="secondary"
          render={
            <a href={`${REPOSITORY_URL}/issues/new/choose`} target="_blank" rel="noreferrer" />
          }
        >
          {t("Report a bug")}
        </Button>
        <span data-setting="diagnostics">
          <DiagnosticsExport />
        </span>
        {status?.distribution === "store" && (
          <Button variant="secondary" disabled={rating.isPending} onClick={() => rating.mutate()}>
            {t("Rate in the Microsoft Store")}
          </Button>
        )}
      </div>
      {rating.isError && (
        <p role="alert" className="mt-2 text-sm">
          {t("The Microsoft Store could not be opened.")}
        </p>
      )}
      {/* TMDB's terms ask for its logo and this notice; JustWatch supplies the streaming data. */}
      <div className="mt-12 text-[0.8125rem] text-muted-foreground">
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" aria-label="TMDB">
          <img src={tmdbLogo} alt="TMDB" className="mb-3 h-3.5" />
        </a>
        <p>
          {t(
            "This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.",
          )}{" "}
          <Message
            text="Where titles stream comes from {justWatch}."
            values={{ justWatch: <Link href="https://www.justwatch.com">JustWatch</Link> }}
          />
        </p>
      </div>
    </section>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children}
    </a>
  );
}

function Rows({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="mb-8 space-y-3.5 text-[0.9375rem]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-4">
          <dt className="w-28 flex-none break-words text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
