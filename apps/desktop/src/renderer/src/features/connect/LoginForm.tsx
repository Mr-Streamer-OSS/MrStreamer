// The fields a subscription is added with, on the Connect screen and in Settings: a server,
// username and password, or one pasted M3U link, an Xtream panel's, which contains them, or any
// playlist's.
//
// An address without a scheme connects over https. When https doesn't work there, the main
// process stops before the login goes out (`unencrypted-only`) and the form asks once whether to
// connect without encryption, which retries the address with http://. An address typed with
// http:// connects as typed, with a line under it saying the login travels as plain text. A
// playlist without a login connects as typed, without that line.
//
// A login sent to be checked can't be called back, so until it is answered the form offers
// neither Cancel nor the switch to its other fields: the subscription may be saved all the same,
// and the question that can follow is about the address that was sent. The fields stay open
// meanwhile, so agreeing connects the login that was sent, whatever they say since.
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Link2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { isMac, isWindows } from "../../app/platform.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { hostOf } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";

export function LoginForm({
  beside = false,
  submit: labels,
  intro,
  onAdded,
  onCancel,
}: {
  /**
   * Adds it beside the subscriptions saved already: asks for a name to list it under, and says
   * under the form that its lists join theirs.
   */
  beside?: boolean;
  /** What the button that adds it says, and says while the provider is asked. */
  submit: { readonly idle: string; readonly pending: string };
  /** A line over the fields, which follows what they ask for. */
  intro?: (mode: "login" | "link") => string;
  onAdded: (added: SubscriptionSummary) => void | Promise<void>;
  /** Shows Cancel, for a form the viewer opened beside something else. */
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<"login" | "link">("login");
  const [name, setName] = useState("");
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState("");

  const add = useMutation({
    mutationFn: (login: LoginInput) => call("subscription.add", login),
    onSuccess: onAdded,
  });

  /** What the form sends for `address`: the server with the login, or the link alone. */
  const login = (address: string): LoginInput => ({
    ...(mode === "link"
      ? { server: address, username: "", password: "" }
      : { server: address, username, password }),
    ...(beside && name.trim() ? { name: name.trim() } : {}),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate(login(mode === "link" ? link : server));
  }

  /**
   * The viewer agreed to connect the address that has no https, over http. The question was about
   * the login that was sent, which the fields can have left since: that one goes again, under the
   * same name, and its address shows in the field.
   */
  function connectUnencrypted() {
    const sent = add.variables;
    if (!sent) return;
    const address = `http://${sent.server.trim()}`;
    (mode === "link" ? setLink : setServer)(address);
    add.mutate({ ...sent, server: address });
  }

  const failure = add.error ? appError(add.error) : null;
  const asking = failure?.kind === "unencrypted-only" ? failure : null;
  const error = failure && !asking ? describeError(failure) : null;
  /** Changes an address. A question about the one before doesn't hold for it. */
  function changeAddress(set: (value: string) => void, value: string) {
    set(value);
    if (asking) add.reset();
  }
  const address = (mode === "link" ? link : server).trim();

  return (
    <form className="flex flex-col" onSubmit={submit}>
      {intro && <p className="mb-9 text-[0.9375rem] text-muted-foreground">{intro(mode)}</p>}
      <div className="space-y-4">
        {beside && (
          <Field label={t("Name")} hint={t("optional, the host without one")}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                address
                  ? hostOf(/^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `https://${address}`)
                  : ""
              }
              autoFocus
            />
          </Field>
        )}
        {mode === "login" ? (
          <>
            <Field label={t("Server")} note={plainHttp(server) ? unencrypted() : null}>
              <Input
                value={server}
                onChange={(e) => changeAddress(setServer, e.target.value)}
                placeholder="line.example.tv:8080"
                autoFocus={!beside}
              />
            </Field>
            <Field label={t("Username")}>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </Field>
            <Field label={t("Password")}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
          </>
        ) : (
          <Field
            label={t("M3U link")}
            note={plainHttp(link) && carriesLogin(link) ? unencrypted() : null}
          >
            <Input
              value={link}
              onChange={(e) => changeAddress(setLink, e.target.value)}
              placeholder="https://example.com/playlist.m3u"
              autoFocus={!beside}
            />
          </Field>
        )}
      </div>

      {error && <p className="mt-5 text-sm text-destructive">{error}</p>}

      {asking ? (
        <div className="mt-8">
          <p className="text-[0.9375rem]">{describeError(asking)}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Your username and password would travel unencrypted.")}
          </p>
          <div className="mt-5 flex items-center gap-3">
            <Button onClick={connectUnencrypted}>{t("Connect without encryption")}</Button>
            <Button variant="ghost" onClick={() => add.reset()}>
              {t("Cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-8 flex items-center gap-3">
          <Button type="submit" variant="primary" size="lg" disabled={add.isPending}>
            {add.isPending ? labels.pending : labels.idle}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            disabled={add.isPending}
            onClick={() => setMode(mode === "login" ? "link" : "login")}
          >
            {mode === "login" ? <Link2 /> : <KeyRound />}
            {mode === "login" ? t("Use an M3U link") : t("Use server and login")}
          </Button>
          {onCancel && (
            <Button
              variant="ghost"
              size="lg"
              className="ml-auto"
              disabled={add.isPending}
              onClick={onCancel}
            >
              {t("Cancel")}
            </Button>
          )}
        </div>
      )}
      <p className="mt-10 text-xs leading-relaxed text-muted-foreground/80">
        {[
          savedWhere(beside),
          encrypted(mode === "link" && !carriesLogin(link) ? "link" : "password"),
          ...(beside ? [t("Its channels, movies and series join the lists.")] : []),
        ].join(" ")}
      </p>
    </form>
  );
}

const unencrypted = () => t("Not encrypted. Your login travels as plain text.");

/** Where a login stays; `checked` when the provider checks it first, as beside others. */
function savedWhere(checked: boolean): string {
  if (isMac)
    return checked
      ? t("Checked with the provider, then saved on this Mac.")
      : t("Saved on this Mac.");
  if (isWindows)
    return checked
      ? t("Checked with the provider, then saved on this PC.")
      : t("Saved on this PC.");
  return checked
    ? t("Checked with the provider, then saved on this computer.")
    : t("Saved on this computer.");
}

/** What keeps a login's secret: the password, or a playlist's whole link. */
function encrypted(secret: "password" | "link"): string {
  if (isMac) {
    return secret === "link"
      ? t("The link is encrypted with your macOS Keychain.")
      : t("The password is encrypted with your macOS Keychain.");
  }
  if (isWindows) {
    return secret === "link"
      ? t("The link is encrypted with your Windows account.")
      : t("The password is encrypted with your Windows account.");
  }
  return secret === "link"
    ? t("The link is encrypted with your keyring.")
    : t("The password is encrypted with your keyring.");
}

/** An address typed with http://, which the login travels over unencrypted. */
function plainHttp(address: string): boolean {
  return /^http:\/\//i.test(address.trim());
}

/** Whether an M3U link names a login, as `get.php?username=…&password=…` does. */
function carriesLogin(link: string): boolean {
  const query = URL.parse(link.trim())?.searchParams;
  return !!query?.get("username") || !!query?.get("password");
}

export function Field({
  label,
  hint,
  note,
  children,
}: {
  label: string;
  /** A few words beside the label. */
  hint?: string;
  /** A line under the control. */
  note?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm text-muted-foreground">
      <span>
        {label}
        {hint && <span className="text-muted-foreground/70"> · {hint}</span>}
      </span>
      {children}
      {note && <span className="text-xs text-foreground/85">{note}</span>}
    </label>
  );
}
