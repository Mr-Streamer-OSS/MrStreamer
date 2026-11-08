// The window bar's profile avatar and the menu it opens (Paper A): every local profile, the active
// one checked and kids ones marked, a row to switch to each other, Delete for an inactive one with
// a question first, New profile with its name field, and Manage profiles for an adult viewer. A
// change the PIN protects asks for it first, or after main refuses it, and forgets it once done or
// closed. A change that fails says why with Retry; a deletion that stopped partway stays listed
// with Retry, and can't be switched to. Switching, its saves and the window's reload belong to
// `profiles.ts`; this only asks for them.
import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Lock, Plus, Trash2 } from "lucide-react";
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
import { cn } from "../../lib/utils.ts";
import { Avatar, Failure, nameOf, PinPrompt } from "./ProfileControls.tsx";
import { ProfileManager } from "./ProfileManager.tsx";
import {
  createProfile,
  describeProfileError,
  pinRefused,
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

export function ProfileMenu() {
  const client = useQueryClient();
  const owner = useSyncExternalStore(subscribeProfiles, profileStatus).owner;
  const list = useQuery(profileListQuery());
  const profiles = list.data ?? [];
  const active = profiles.find((profile) => profile.id === owner?.id);
  const [open, setOpen] = useState(false);
  // Manage profiles opens once the menu has closed, so the menu's focus return can't take the
  // keyboard from the sheet's PIN field.
  const [managing, setManaging] = useState<"next" | boolean>(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  // The change waiting for the PIN, and the PIN typed for it. Neither outlives the menu.
  const [asking, setAsking] = useState<Change | null>(null);
  const [pin, setPin] = useState("");
  const [wrongPin, setWrongPin] = useState(false);

  const profileButton = useRef<HTMLButtonElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const pinField = useRef<HTMLInputElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const previous = useRef({ confirming, naming, asking, managing });
  useLayoutEffect(() => {
    const before = previous.current;

    // The manager's menu row has unmounted; return to the surviving profile control.
    if (before.managing === true && managing === false) profileButton.current?.focus();
    else if (asking) {
      if (!before.asking) pinField.current?.focus();
    } else if (confirming) cancelButton.current?.focus();
    else if (before.asking)
      (before.asking.kind === "create"
        ? (nameField.current ?? newButton.current)
        : (rows.current.get(before.asking.id) ?? newButton.current)
      )?.focus();
    else if (before.confirming) (rows.current.get(before.confirming) ?? newButton.current)?.focus();
    else if (before.naming && !naming) newButton.current?.focus();
    previous.current = { confirming, naming, asking, managing };
  }, [confirming, naming, asking, managing]);

  const stopNaming = () => {
    setNaming(false);
    setName("");
  };

  const forgetPin = () => {
    setAsking(null);
    setPin("");
    setWrongPin(false);
  };

  const change = useMutation({
    // The PIN stays out of the mutation's variables, which the query client keeps after it ends.
    mutationFn: (next: Change) => {
      const typed = pin || undefined;

      return next.kind === "switch"
        ? switchProfile(client, next.id, typed)
        : next.kind === "create"
          ? createProfile(client, next.name, typed)
          : removeProfile(client, next.id, typed);
    },
    onSuccess: (_, next) => {
      forgetPin();

      if (next.kind === "create") stopNaming();
    },
    onError: (cause, next) => {
      if (!pinRefused(cause)) return setAsking(null);
      // Ask again: a PIN that was typed was wrong; none typed means main wanted one.
      setWrongPin(pin !== "");
      setPin("");
      setAsking(next);
      pinField.current?.focus();
    },
    // A refused deletion can leave its profile marked as deleting; the list shows it with Retry.
    onSettled: (_, __, next) => {
      if (next.kind === "remove") setConfirming(null);
    },
  });

  const kidsActive = active?.kids === true;

  // Leaving a kids profile for an adult one needs the PIN; so does adding or deleting once kids
  // profiles exist. Main may still ask where this can't tell (a PIN with no kids profiles left).
  const needsPin = (next: Change) =>
    next.kind === "switch"
      ? kidsActive && !profiles.find((profile) => profile.id === next.id)?.kids
      : profiles.some((profile) => profile.kids);

  // One change at a time; main would refuse a second while the first holds the profiles.
  const send = (next: Change) => {
    if (change.isPending) return;

    if (!pin && needsPin(next)) {
      setConfirming(null);
      setAsking(next);

      return;
    }

    change.mutate(next);
  };

  const busy = (kind: Change["kind"], id?: string) =>
    change.isPending &&
    change.variables.kind === kind &&
    (!id || ("id" in change.variables && change.variables.id === id));

  const failed = change.isError && !asking ? change.variables : null;
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
      open={open}
      onOpenChangeComplete={(opened) => {
        if (!opened && managing === "next") setManaging(true);
      }}
      onOpenChange={(next) => {
        setOpen(next);

        if (next) return;
        setConfirming(null);
        stopNaming();
        forgetPin();

        if (change.isError) change.reset();
      }}
    >
      <Popover.Trigger
        ref={profileButton}
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
                text={describeProfileError(list.error)}
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
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              "block truncate",
                              current ? "font-semibold" : "font-medium",
                            )}
                          >
                            {nameOf(profile)}
                          </span>
                          {profile.kids && (
                            <span className="block text-xs leading-[14px] text-muted-foreground">
                              {t("Kids · allowed titles only")}
                            </span>
                          )}
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
                  ref={nameField}
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
            {!kidsActive && list.isSuccess && (
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  setConfirming(null);
                  stopNaming();
                  forgetPin();
                  setManaging("next");
                }}
                className={cn(
                  menuItem,
                  "flex h-9 w-full items-center gap-2.5 px-2 text-left hover:bg-white/10 focus-visible:bg-white/10",
                )}
              >
                <Lock aria-hidden className="size-[15px] text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{t("Manage profiles")}</span>
                <span className="text-xs leading-[14px] text-muted-foreground">{t("PIN")}</span>
              </button>
            )}
            {asking && (
              <PinPrompt
                field={pinField}
                prompt={promptFor(asking, profiles)}
                action={
                  asking.kind === "switch"
                    ? busy("switch")
                      ? t("Switching…")
                      : t("Switch")
                    : asking.kind === "create"
                      ? busy("create")
                        ? t("Adding…")
                        : t("Add")
                      : busy("remove")
                        ? t("Deleting…")
                        : t("Delete")
                }
                busy={change.isPending}
                wrong={wrongPin}
                pin={pin}
                onPin={setPin}
                onSubmit={() => {
                  if (pin && !change.isPending) change.mutate(asking);
                }}
                onCancel={forgetPin}
              />
            )}
            {failed && (
              <Failure text={describeProfileError(change.error)} onRetry={() => send(failed)} />
            )}
            <p className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
              {t(
                "Recordings and downloads are shared. Lists, progress and favourites stay with each profile.",
              )}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
      {managing === true && <ProfileManager onClose={() => setManaging(false)} />}
    </Popover.Root>
  );
}

/** What the PIN is asked for, naming the profile the change is about. */
function promptFor(next: Change, profiles: readonly LocalProfile[]): string {
  if (next.kind === "create") return t("Enter the PIN to add {name}.", { name: next.name });
  const profile = profiles.find((row) => row.id === next.id);
  const name = profile ? nameOf(profile) : "";

  return next.kind === "switch"
    ? t("Enter the PIN to switch to {name}.", { name })
    : t("Enter the PIN to delete {name}.", { name });
}
