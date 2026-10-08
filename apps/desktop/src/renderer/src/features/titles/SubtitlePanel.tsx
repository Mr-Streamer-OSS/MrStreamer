// CC keeps the picture playing and the panel open while the viewer compares results.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SubtitleServiceFailure } from "@mrstreamer/contracts/online-subtitles";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { Button } from "../../components/ui/button.tsx";
import { onlineSubtitles, useOnlineSubtitles } from "../../player/online-subtitles.ts";
import { titlePlayer, useTitlePlayer } from "../../player/title-player.ts";
import { subtitleSettingsQuery } from "../settings/OnlineSubtitlesSection.tsx";
import { Choice } from "../watch/TrackMenus.tsx";

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
      onlineSubtitles.cancelPending();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <aside
      ref={root}
      aria-label="Subtitle choices"
      className="no-drag fixed top-12 right-0 bottom-0 z-40 w-[25rem] max-w-full overflow-y-auto border-l border-white/20 bg-black p-5 text-white"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
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
            {languageName(saved.subtitle.language)} · Saved for this version
          </span>
        </Choice>
      )}
      {saved?.subtitle && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          onClick={() => {
            onlineSubtitles.bind(null);
            onlineSubtitles.bind(sessionId);
            setForgetError(false);
            void titlePlayer.forgetDownloaded().catch(() => setForgetError(true));
          }}
        >
          Forget downloaded subtitles
        </Button>
      )}
      {forgetError && (
        <p role="alert" className="mt-2 text-sm">
          Saved subtitles could not be removed.
        </p>
      )}
      <div className="mt-5 border-t border-white/20 pt-4">
        {!settings.data?.enabled ? (
          <p className="text-sm">Online search is off. Turn it on in Settings.</p>
        ) : (
          <>
            <label className="mb-3 block text-sm">
              Search language
              <select
                aria-label="Subtitle search language"
                className="ml-3 border border-white/30 bg-black p-1"
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
            </label>
            <p className="mb-3 text-sm">
              {settings.data.languages.map(languageName).join(", ")}. Title searches may need a
              different release.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={!sessionId || search.pending !== null}
              onClick={() =>
                void onlineSubtitles.search(language === "saved" ? undefined : [language])
              }
            >
              {search.searched ? "Search again" : "Search subtitles"}
            </Button>
            <p className="mt-2 text-xs">
              Choose a result to download. Accounts and saved languages are in Settings.
            </p>
          </>
        )}
        {search.pending && (
          <div role="status" className="mt-3 flex items-center gap-3 text-sm">
            <span>{search.pending === "search" ? "Searching" : "Downloading"}</span>
            <Button size="sm" variant="secondary" onClick={() => onlineSubtitles.cancelPending()}>
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
                {languageName(result.language)}
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
      </div>
    </aside>
  );
}
