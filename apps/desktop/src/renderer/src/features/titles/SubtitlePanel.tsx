// CC, while a title plays here: every subtitle control in one panel. The file's tracks and the
// saved download, their timing and look, then online search and its results. The picture keeps
// playing and the panel stays open while the viewer compares results and steps the timing.
//   Up and Down walk its rows, Tab reaches its fields, Escape closes it from anywhere.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SubtitleServiceFailure } from "@mrstreamer/contracts/online-subtitles";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { regionalLanguageName } from "@mrstreamer/core/ondemand/tracks";
import { openOnlineSubtitleSettings, useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { onlineSubtitles, useOnlineSubtitles } from "../../player/online-subtitles.ts";
import { titlePlayer, useTitlePlayer } from "../../player/title-player.ts";
import { subtitleSettingsQuery } from "../settings/OnlineSubtitlesSection.tsx";
import { LookRows, subtitleSettingsFor, TextButton } from "../watch/SubtitleSettings.tsx";
import { Choice, moveFocus } from "../watch/TrackMenus.tsx";
import { PanelSection } from "./PanelSection.tsx";
import { SubtitleTimingSection } from "./SubtitleTimingControls.tsx";

const failureText: Record<SubtitleServiceFailure, string> = {
  "not-configured": "Set up in Settings",
  credentials: "Check your account in Settings",
  quota: "Service allowance reached",
  unavailable: "Service unavailable",
  unsupported: "Unsupported subtitle",
};
export function SubtitlePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessionId = useTitlePlayer((state) => state.subtitleSessionId);
  const subtitle = useTitlePlayer((state) => state.subtitle);
  const tracks = useTitlePlayer((state) => state.subtitles);
  const saved = useTitlePlayer((state) => state.savedSubtitle);
  const downloadedOn = useTitlePlayer((state) => state.downloadedOn);
  const search = useOnlineSubtitles((state) => state);
  const settings = useQuery({ ...subtitleSettingsQuery, enabled: open });
  const root = useRef<HTMLElement>(null);
  const [language, setLanguage] = useState("saved");
  const [forgetError, setForgetError] = useState(false);
  useEffect(() => {
    onlineSubtitles.bind(sessionId);
    return () => onlineSubtitles.bind(null);
  }, [sessionId]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    root.current?.querySelector<HTMLElement>("[aria-pressed=true]")?.focus();
    return () => {
      onlineSubtitles.dismissPending();
      // Settings opened from here covers the title: focus on a button underneath would show its
      // tooltip, which takes the first Escape from Settings.
      if (useUi.getState().settings) return;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  // At the window: a result picked with the pointer goes disabled while it downloads, and focus
  // leaves the panel with it. Settings and search over the title keep their own Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const ui = useUi.getState();
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (ui.searchOpen || ui.settings || ui.updateDialog) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, onClose]);
  if (!open) return null;
  const downloaded = downloadedOn && saved?.subtitle != null;
  const settingsFor = subtitleSettingsFor(tracks, subtitle, downloaded);
  return (
    <aside
      ref={root}
      aria-label="Subtitle choices"
      className="no-drag fixed top-12 right-0 bottom-0 z-40 w-[25rem] max-w-full overflow-y-auto border-l border-white/20 bg-black p-5 text-white"
      onKeyDown={moveFocus}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Subtitles</h2>
        <Button aria-label="Close subtitles" variant="media" size="icon-sm" onClick={onClose}>
          <X />
        </Button>
      </div>
      <Choice chosen={!subtitle && !downloadedOn} onChoose={() => titlePlayer.setSubtitle(null)}>
        Off
      </Choice>
      {tracks.map((track) => (
        <Choice
          key={`${track.id}:${track.page}`}
          chosen={!downloadedOn && subtitle?.id === track.id && subtitle.page === track.page}
          onChoose={() => titlePlayer.setSubtitle(track)}
        >
          {track.label}
        </Choice>
      ))}
      {saved?.subtitle && (
        <Choice chosen={downloadedOn} onChoose={() => titlePlayer.showDownloaded()}>
          <span className="block break-words">{saved.subtitle.release || "Saved subtitle"}</span>
          <span className="block text-xs">
            {regionalLanguageName(saved.subtitle.language)} · Saved for this version
          </span>
        </Choice>
      )}
      {saved?.subtitle && (
        <div className="mt-1 pl-4.5">
          <TextButton
            onClick={() => {
              onlineSubtitles.bind(null);
              onlineSubtitles.bind(sessionId);
              setForgetError(false);
              void titlePlayer.forgetDownloaded().catch(() => setForgetError(true));
            }}
          >
            Forget downloaded subtitles
          </TextButton>
        </div>
      )}
      {forgetError && (
        <p role="alert" className="mt-2 text-sm">
          Saved subtitles could not be removed.
        </p>
      )}
      {settingsFor.timing && <SubtitleTimingSection downloaded={downloaded} />}
      {settingsFor.look && (
        <PanelSection title="Look">
          <LookRows text={settingsFor.text} />
        </PanelSection>
      )}
      <PanelSection
        title="Find online"
        aside={
          <TextButton
            onClick={() => {
              onClose();
              openOnlineSubtitleSettings();
            }}
          >
            Settings
          </TextButton>
        }
      >
        {settings.data?.enabled && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Subtitle search language"
              className="h-8 rounded-lg border border-white/30 bg-black px-1 text-[0.8125rem]"
              value={language}
              onChange={(event) => setLanguage(event.currentTarget.value)}
            >
              <option value="saved">Saved languages</option>
              {TITLE_LANGUAGES.map(({ code, name }) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <Button
              data-item
              variant="secondary"
              size="sm"
              disabled={!sessionId || search.pending !== null}
              onClick={() =>
                void onlineSubtitles.search(language === "saved" ? undefined : [language])
              }
            >
              {search.searched ? "Search again" : "Search subtitles"}
            </Button>
            {downloaded && search.results.length > 1 && (
              <Button
                data-item
                variant="secondary"
                size="sm"
                disabled={search.pending !== null}
                onClick={() => onlineSubtitles.tryNext()}
              >
                Try the next result
              </Button>
            )}
          </div>
        )}
        {search.pending && (
          <div role="status" className="mt-3 flex items-center gap-3 text-sm">
            <span>{search.pending === "search" ? "Searching" : "Downloading"}</span>
            <Button
              data-item
              size="sm"
              variant="secondary"
              onClick={() => onlineSubtitles.dismissPending()}
            >
              Cancel
            </Button>
          </div>
        )}
        {search.error && (
          <p role="alert" className="mt-3 text-sm">
            {search.error}
          </p>
        )}
        {search.failures.map(({ service, reason }) => (
          <p key={service} className="mt-3 text-sm">
            {service === "subdl" ? "SubDL" : "OpenSubtitles"}: {failureText[reason]}
          </p>
        ))}
        {search.searched && !search.pending && search.results.length === 0 && !search.error && (
          <p className="mt-3 text-sm">No subtitles found. Try another language in Settings.</p>
        )}
        <div className="mt-3">
          {search.results.map((result) => (
            <button
              key={result.id}
              data-item
              aria-pressed={downloadedOn && search.selected === result.id}
              disabled={search.pending !== null || !settings.data?.enabled}
              className="block w-full border-b border-white/10 py-3 text-left outline-none hover:bg-white/8 focus-visible:bg-white/10 disabled:opacity-50"
              onClick={() => void onlineSubtitles.choose(result.id)}
            >
              <span className="block break-words font-mono text-xs">
                {result.release || "Untitled release"}
              </span>
              <span className="mt-1 block text-xs">
                {result.service === "subdl" ? "SubDL" : "OpenSubtitles"} ·{" "}
                {regionalLanguageName(result.language)}
                {result.hearingImpaired ? " · Hearing impaired" : ""}
                {result.downloads !== null
                  ? ` · ${result.downloads.toLocaleString()} downloads`
                  : ""}
              </span>
            </button>
          ))}
        </div>
        {search.quota && (
          <p className="mt-3 text-xs">
            {search.quota.remaining} service downloads remain
            {search.quota.resetAt ? ` · Resets ${search.quota.resetAt}` : ""}
          </p>
        )}
      </PanelSection>
    </aside>
  );
}
