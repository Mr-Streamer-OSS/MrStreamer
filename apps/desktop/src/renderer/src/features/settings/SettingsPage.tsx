import { useEffect, type ReactNode } from "react";
import { isTyping } from "../../app/platform.ts";
import { useUi, type SettingsTab } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { cn } from "../../lib/utils.ts";
import tmdbLogo from "../../assets/tmdb.svg";
import { GeneralSection } from "./GeneralSection.tsx";
import { Licences } from "./Licences.tsx";
import { SubscriptionSection } from "./SubscriptionSection.tsx";
import { useUpdates } from "../updates/use-updates.ts";

const TABS: readonly { value: SettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "subscription", label: "Subscription" },
  { value: "about", label: "About" },
];

const REPOSITORY_URL = "https://github.com/Mr-Streamer-OSS/MrStreamer";
const PRIVACY_URL = "https://mrstreamer.app/privacy";

/**
 * Settings, a page over the current view, so a channel keeps playing underneath. Opens with ⌘,
 * or Ctrl , on the tab its opener asks for. Back in the top bar, or Escape, returns to the view;
 * a dialog over the page closes first.
 */
export function SettingsPage() {
  const tab = useUi((state) => state.settings);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog or popup over the page closes itself first.
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      const current = useUi.getState().settings;
      // Fields keep Escape, except the licences' search, which has nothing to undo.
      if (!current || (isTyping(event) && current !== "licences")) return;
      // The licences go back to About, the rest to the view underneath.
      useUi.setState({ settings: current === "licences" ? "about" : null });
      // Handled: the view underneath must not take the same Escape.
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!tab) return null;
  const shownTab = tab === "licences" ? "about" : tab;
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <WindowBar className="bg-black" />
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 flex-none border-r border-border px-4 pt-4">
          <h1 className="mb-4 px-3 text-2xl font-semibold tracking-tight">Settings</h1>
          {TABS.map((entry) => (
            <button
              key={entry.value}
              aria-current={entry.value === shownTab ? "page" : undefined}
              onClick={() => useUi.setState({ settings: entry.value })}
              className={cn(
                "mb-0.5 block w-full rounded-lg px-3 py-2 text-left text-[0.9375rem] transition-colors",
                entry.value === shownTab
                  ? "bg-white/10 text-white"
                  : "text-muted-foreground hover:bg-white/5 hover:text-white",
              )}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        {tab === "licences" ? (
          <Licences />
        ) : (
          <main className="min-w-0 flex-1 overflow-y-auto px-10 pt-6 pb-10">
            <div className="max-w-[40rem]">
              {tab === "general" && <GeneralSection />}
              {tab === "subscription" && <SubscriptionSection />}
              {tab === "about" && <About />}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

/**
 * The installed version, where the project lives, the commit the build comes from, its licences,
 * the privacy policy and how to report a bug.
 */
function About() {
  const { status } = useUpdates();
  const rows: [string, ReactNode][] = [
    [
      "Version",
      status ? `${status.version} · ${status.channel === "nightly" ? "Nightly" : "Stable"}` : "",
    ],
    ["Website", <Link href="https://mrstreamer.app">mrstreamer.app</Link>],
    [
      "Source",
      <>
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
      </>,
    ],
    [
      "Licences",
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => useUi.setState({ settings: "licences" })}
        className="underline underline-offset-4"
      >
        Open-source licences
      </button>,
    ],
    ["Privacy", <Link href={PRIVACY_URL}>mrstreamer.app/privacy</Link>],
  ];
  return (
    <section>
      <Rows rows={rows} />
      <Button
        variant="secondary"
        render={<a href={`${REPOSITORY_URL}/issues/new/choose`} target="_blank" rel="noreferrer" />}
      >
        Report a bug
      </Button>
      {/* TMDB's terms ask for its logo and this notice; JustWatch supplies the streaming data. */}
      <div className="mt-12 text-[0.8125rem] text-muted-foreground">
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" aria-label="TMDB">
          <img src={tmdbLogo} alt="TMDB" className="mb-3 h-3.5" />
        </a>
        <p>
          This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise
          approved by TMDB. Where titles stream comes from{" "}
          <Link href="https://www.justwatch.com">JustWatch</Link>.
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
          <dt className="w-28 flex-none text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 truncate">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
