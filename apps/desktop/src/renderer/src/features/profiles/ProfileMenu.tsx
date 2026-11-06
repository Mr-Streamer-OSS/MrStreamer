// The window bar's profile avatar and the menu it opens (Paper A): every local profile, the active
// one checked, a row to switch to each other, Delete for an inactive one with a question first,
// and New profile with its name field. A change that fails says why with Retry; a deletion that
// stopped partway stays listed with Retry, and can't be switched to. Switching, its saves and the
// window's reload belong to `profiles.ts`; this only asks for them.
import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";
import {
  useState,
  useSyncExternalStore,
  useRef,
  useLayoutEffect,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { DEFAULT_PROFILE_ID, type LocalProfile } from "@mrstreamer/contracts/profiles";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { cn } from "../../lib/utils.ts";
import {
  createProfile,
  profileListQuery,
  profileStatus,
  removeProfile,
  subscribeProfiles,
  switchProfile,
} from "./profiles.ts";

/** The longest name main accepts, after trimming. */
const NAME_MAX = 80;

type Change =
  | { readonly kind: "switch"; readonly id: string }
  | { readonly kind: "create"; readonly name: string }
  | { readonly kind: "remove"; readonly id: string };

/** Default is the app's own profile, named in the window's language rather than stored words. */
const nameOf = (profile: LocalProfile) =>
  profile.id === DEFAULT_PROFILE_ID ? t("Default") : profile.name;

/** Avatar fills from Paper A, one per profile id, so a profile keeps its colour across lists. */
const FILLS = ["#2E5E4E", "#5E3A2E", "#3A3A6E"] as const;

function Avatar({ profile }: { profile: LocalProfile | undefined }) {
  const name = profile ? nameOf(profile) : "";
  const hash = [...(profile?.id ?? "")].reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), 0);

  return (
    <span
      aria-hidden
      className="grid size-7 flex-none place-items-center rounded-full text-xs leading-[14px] font-bold text-foreground"
      style={{ backgroundColor: profile ? FILLS[hash % FILLS.length] : "var(--accent)" }}
    >
      {[...name.trim()][0]?.toLocaleUpperCase()}
    </span>
  );
}

export function ProfileMenu() {
  const client = useQueryClient();
  const owner = useSyncExternalStore(subscribeProfiles, profileStatus).owner;
  const list = useQuery(profileListQuery());
  const profiles = list.data ?? [];
  const active = profiles.find((profile) => profile.id === owner?.id);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const newButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const previous = useRef({ confirming, naming });
  useLayoutEffect(() => {
    const before = previous.current;

    if (confirming) cancelButton.current?.focus();
    else if (before.confirming) (rows.current.get(before.confirming) ?? newButton.current)?.focus();
    else if (before.naming && !naming) newButton.current?.focus();
    previous.current = { confirming, naming };
  }, [confirming, naming]);

  const stopNaming = () => {
    setNaming(false);
    setName("");
  };

  const change = useMutation({
    mutationFn: (next: Change) =>
      next.kind === "switch"
        ? switchProfile(client, next.id)
        : next.kind === "create"
          ? createProfile(client, next.name)
          : removeProfile(client, next.id),
    onSuccess: (_, next) => {
      if (next.kind === "create") stopNaming();
    },
    // A refused deletion can leave its profile marked as deleting; the list shows it with Retry.
    onSettled: (_, __, next) => {
      if (next.kind === "remove") setConfirming(null);
    },
  });

  // One change at a time; main would refuse a second while the first holds the profiles.
  const send = (next: Change) => {
    if (!change.isPending) change.mutate(next);
  };

  const busy = (kind: Change["kind"], id?: string) =>
    change.isPending &&
    change.variables.kind === kind &&
    (!id || ("id" in change.variables && change.variables.id === id));

  const failed = change.isError ? change.variables : null;
  const trimmed = name.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (trimmed) send({ kind: "create", name: trimmed });
  };

  // Escape leaves the name field, not the menu.
  const leaveField = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    stopNaming();
  };

  const label = active ? t("Profile: {name}", { name: nameOf(active) }) : t("Profiles");

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) return;
        setConfirming(null);
        stopNaming();

        if (change.isError) change.reset();
      }}
    >
      <Popover.Trigger
        render={
          <button
            aria-label={label}
            title={label}
            onMouseDown={(event) => event.preventDefault()}
            className="ml-1 grid size-8 flex-none place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <Avatar profile={active} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
          <Popover.Popup
            aria-label={t("Profiles")}
            className={cn(
              menuSurface,
              "w-[18.75rem] max-h-[var(--available-height)] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain text-[0.8125rem] leading-4 text-foreground",
            )}
          >
            {list.isError ? (
              <Failure
                text={describeError(appError(list.error))}
                onRetry={() => void list.refetch()}
              />
            ) : (
              <ul aria-label={t("Profiles")} aria-busy={list.isPending || undefined}>
                {profiles.map((profile) => {
                  const current = profile.id === owner?.id;
                  const row = "flex min-h-11 items-center gap-2.5 px-2 py-2";

                  if (confirming === profile.id)
                    return (
                      <li key={profile.id} className="rounded-lg bg-accent p-2">
                        <p className="pb-2">
                          {t(
                            "Delete {name}? Their lists, progress and settings go. Recordings and downloads stay.",
                            { name: nameOf(profile) },
                          )}
                        </p>
                        <div className="flex justify-end gap-2">
                          <Button
                            ref={cancelButton}
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirming(null)}
                          >
                            {t("Cancel")}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            aria-busy={busy("remove", profile.id) || undefined}
                            onClick={() => send({ kind: "remove", id: profile.id })}
                          >
                            {busy("remove", profile.id) ? t("Deleting…") : t("Delete")}
                          </Button>
                        </div>
                      </li>
                    );

                  if (profile.deleting)
                    return (
                      <li key={profile.id} className={row}>
                        <Avatar profile={profile} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{nameOf(profile)}</span>
                          <span className="block text-xs leading-[14px] text-muted-foreground">
                            {t("Deleting didn't finish")}
                          </span>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("Retry deleting {name}", { name: nameOf(profile) })}
                          onClick={() => send({ kind: "remove", id: profile.id })}
                        >
                          {busy("remove", profile.id) ? t("Deleting…") : t("Retry")}
                        </Button>
                      </li>
                    );

                  return (
                    <li
                      key={profile.id}
                      aria-current={current || undefined}
                      className={cn("group flex items-center rounded-lg", current && "bg-accent")}
                    >
                      <button
                        ref={(element) => {
                          if (element) rows.current.set(profile.id, element);
                          else rows.current.delete(profile.id);
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => !current && send({ kind: "switch", id: profile.id })}
                        aria-busy={busy("switch", profile.id) || undefined}
                        className={cn(
                          menuItem,
                          row,
                          "min-w-0 flex-1 text-left focus-visible:bg-white/10",
                          !current && "hover:bg-white/10",
                        )}
                      >
                        <Avatar profile={profile} />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate",
                            current ? "font-semibold" : "font-medium",
                          )}
                        >
                          {nameOf(profile)}
                        </span>
                        {current ? (
                          <Check aria-hidden className="size-4 flex-none" strokeWidth={2.5} />
                        ) : (
                          busy("switch", profile.id) && (
                            <span className="text-xs text-muted-foreground">{t("Switching…")}</span>
                          )
                        )}
                      </button>
                      {!current && profile.id !== DEFAULT_PROFILE_ID && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("Delete {name}", { name: nameOf(profile) })}
                          title={t("Delete {name}", { name: nameOf(profile) })}
                          onClick={() => setConfirming(profile.id)}
                          className="mr-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mx-0 my-1.5 h-px bg-white/8" />
            {naming ? (
              <form onSubmit={submit} className="flex items-center gap-2 px-1 py-1">
                <Input
                  compact
                  autoFocus
                  aria-label={t("Profile name")}
                  placeholder={t("Profile name")}
                  maxLength={NAME_MAX}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={leaveField}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  aria-disabled={!trimmed || undefined}
                  aria-busy={busy("create") || undefined}
                >
                  {busy("create") ? t("Adding…") : t("Add")}
                </Button>
              </form>
            ) : (
              <button
                ref={newButton}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setNaming(true)}
                className={cn(
                  menuItem,
                  "flex h-9 w-full items-center gap-2.5 px-2 text-left hover:bg-white/10 focus-visible:bg-white/10",
                )}
              >
                <Plus aria-hidden className="size-[15px] text-muted-foreground" />
                {t("New profile")}
              </button>
            )}
            {failed && (
              <Failure text={describeError(appError(change.error))} onRetry={() => send(failed)} />
            )}
            <p className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
              {t(
                "Recordings and downloads are shared. Lists, progress and favourites stay with each profile.",
              )}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** What a failed read or change came to, with Retry. */
function Failure({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 px-2 py-1.5">
      <span className="min-w-0 flex-1">{text}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t("Retry")}
      </Button>
    </div>
  );
}
