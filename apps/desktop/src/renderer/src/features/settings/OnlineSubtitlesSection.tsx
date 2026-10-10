// Settings reads secret presence only. Saving configuration never searches or downloads.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  OnlineSubtitlePreferences,
  SubtitleCredentials,
  SubtitleService,
} from "@mrstreamer/contracts/online-subtitles";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { call } from "../../lib/ipc.ts";
import { Row, RowForm, Section, Select } from "./Rows.tsx";

export const subtitleSettingsQuery = {
  queryKey: ["subtitles", "settings"] as const,
  queryFn: () => call("subtitles.settings"),
};
export function OnlineSubtitlesSection() {
  const client = useQueryClient();
  const settings = useQuery({ ...subtitleSettingsQuery, refetchOnMount: "always" });
  const [editing, setEditing] = useState<SubtitleService | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const saved = settings.data;
  // Opened from a title's CC panel: the section comes into view, once.
  const section = useRef<HTMLElement>(null);
  const asked = useUi((state) => state.onlineSubtitles);
  useEffect(() => {
    if (!asked) return;
    section.current?.scrollIntoView();
    useUi.setState({ onlineSubtitles: false });
  }, [asked]);
  const update = useMutation({
    mutationFn: ({
      preferences,
      credentials,
    }: {
      preferences: OnlineSubtitlePreferences;
      credentials?: SubtitleCredentials;
    }) => call("subtitles.configure", { preferences, ...(credentials ? { credentials } : {}) }),
    onSuccess: (next, input) => {
      client.setQueryData(subtitleSettingsQuery.queryKey, next);
      if (input.credentials) {
        setEditing(null);
        setApiKey("");
        setUsername("");
        setPassword("");
      }
    },
  });
  const change = (patch: Partial<OnlineSubtitlePreferences>, credentials?: SubtitleCredentials) => {
    if (!saved || update.isPending) return;
    update.mutate({
      preferences: {
        enabled: saved.enabled,
        service: saved.service,
        languages: saved.languages,
        ...patch,
      },
      ...(credentials ? { credentials } : {}),
    });
  };
  return (
    <Section ref={section} title={t("Online subtitles")}>
      <p className="py-2 text-sm">
        {t(
          "Search only when you ask. The selected services receive the TMDB identity, or the title and year when no identity is known, plus the episode and languages. Provider links and logins stay on this computer.",
        )}
      </p>
      <Row label={t("Online search")}>
        <input
          type="checkbox"
          aria-label={t("Online subtitle search")}
          checked={saved?.enabled ?? false}
          disabled={!saved || update.isPending}
          onChange={(event) => change({ enabled: event.currentTarget.checked })}
        />
      </Row>
      <Row label={t("Search services")}>
        <Select
          label={t("Subtitle search services")}
          value={saved?.service ?? "both"}
          options={[
            { value: "both", label: t("Every service set up") },
            { value: "subdl", label: "SubDL" },
            { value: "opensubtitles", label: "OpenSubtitles" },
          ]}
          onChange={(service) => change({ service })}
        />
      </Row>
      <fieldset disabled={!saved || update.isPending} className="border-b border-white/8 py-3">
        <legend className="pt-3">{t("Languages")}</legend>
        <div className="grid grid-cols-3 gap-2 pt-2">
          {TITLE_LANGUAGES.map(({ code, name }) => (
            <label key={code} lang={code} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={saved?.languages.includes(code) ?? false}
                onChange={(event) => {
                  if (!saved) return;
                  const languages = event.currentTarget.checked
                    ? [...saved.languages, code]
                    : saved.languages.filter((each) => each !== code);
                  if (languages.length > 0 && languages.length <= 10) change({ languages });
                }}
              />
              {name}
            </label>
          ))}
        </div>
      </fieldset>
      {(["subdl", "opensubtitles"] as const).map((service) => (
        <div key={service}>
          <Row
            label={service === "subdl" ? "SubDL" : "OpenSubtitles"}
            note={saved?.configured[service] ? t("Saved") : t("Not set up")}
          >
            <Button
              size="sm"
              variant="secondary"
              disabled={!saved || update.isPending}
              onClick={() => {
                setEditing(editing === service ? null : service);
                setApiKey("");
                setUsername("");
                setPassword("");
              }}
            >
              {saved?.configured[service] ? t("Replace") : t("Set up")}
            </Button>
            {saved?.configured[service] && (
              <Button
                size="sm"
                variant="secondary"
                disabled={update.isPending}
                onClick={() => change({}, { [service]: null })}
              >
                {t("Remove")}
              </Button>
            )}
          </Row>
          {editing === service && (
            <RowForm
              onSubmit={() => {
                if (
                  !apiKey.trim() ||
                  (service === "opensubtitles" && (!username.trim() || !password))
                )
                  return;
                change(
                  {},
                  service === "subdl"
                    ? { subdl: { apiKey: apiKey.trim() } }
                    : {
                        opensubtitles: {
                          apiKey: apiKey.trim(),
                          username: username.trim(),
                          password,
                        },
                      },
                );
              }}
            >
              <p className="mb-3 text-sm">
                {service === "subdl"
                  ? t("Use the API key from your SubDL account.")
                  : t(
                      "Use your OpenSubtitles API key and account. Login happens when you download.",
                    )}
              </p>
              <Input
                type="password"
                aria-label={t("{service} API key", {
                  service: service === "subdl" ? "SubDL" : "OpenSubtitles",
                })}
                placeholder={t("API key")}
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
              {service === "opensubtitles" && (
                <div className="mt-2 space-y-2">
                  <Input
                    aria-label={t("OpenSubtitles username")}
                    placeholder={t("Username")}
                    value={username}
                    onChange={(event) => setUsername(event.currentTarget.value)}
                  />
                  <Input
                    type="password"
                    aria-label={t("OpenSubtitles password")}
                    placeholder={t("Password")}
                    autoComplete="off"
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                  />
                </div>
              )}
              <Button
                type="submit"
                size="sm"
                variant="primary"
                className="mt-3"
                disabled={
                  update.isPending ||
                  !apiKey.trim() ||
                  (service === "opensubtitles" && (!username.trim() || !password))
                }
              >
                {t("Save")}
              </Button>
            </RowForm>
          )}
        </div>
      ))}
      {(settings.isError || update.isError) && (
        <p role="alert" className="pt-3 text-sm">
          {t("Subtitle settings could not be saved or read. Your saved keys were not changed.")}
        </p>
      )}
    </Section>
  );
}
