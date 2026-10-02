import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, KeyRound } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { isMac, isWindows } from "../../app/platform.ts";
import { resetForAccount, useUi } from "../../app/ui-store.ts";
import { Logo } from "../../components/Logo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { player } from "../../player/player.ts";

/**
 * First-run login, also used to correct the login of an existing subscription (`existing`).
 * Accepts either server, username and password, or one pasted M3U link that contains them.
 *
 * An address without a scheme connects over https. When https doesn't work there, the main
 * process stops before the login goes out (`unencrypted-only`) and the form asks once whether to
 * connect without encryption, which retries the address with http://. An address typed with
 * http:// connects as typed, with a line under it saying the login travels as plain text.
 */
export function ConnectScreen({ existing }: { existing: SubscriptionSummary | null }) {
  const client = useQueryClient();
  const [mode, setMode] = useState<"login" | "link">("login");
  const [server, setServer] = useState(existing?.server ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState("");

  const connect = useMutation({
    mutationFn: (login: LoginInput) => call("subscription.connect", login),
    onSuccess: async (connected) => {
      const sameAccount =
        existing?.server === connected.server && existing.username === connected.username;
      if (!sameAccount) {
        player.reset();
        resetForAccount();
      }
      useUi.setState({ editingLogin: false });
      await client.resetQueries();
    },
  });

  /** What the form sends for `address`: the server with the login, or the link alone. */
  const login = (address: string): LoginInput =>
    mode === "link"
      ? { server: address, username: "", password: "" }
      : { server: address, username, password };

  function submit(event: FormEvent) {
    event.preventDefault();
    connect.mutate(login(mode === "link" ? link : server));
  }

  /** The viewer agreed to connect the address that has no https, over http. */
  function connectUnencrypted() {
    const address = `http://${(mode === "link" ? link : server).trim()}`;
    (mode === "link" ? setLink : setServer)(address);
    connect.mutate(login(address));
  }

  const failure = connect.error ? appError(connect.error) : null;
  const asking = failure?.kind === "unencrypted-only" ? failure : null;
  const error = failure && !asking ? describeError(failure) : null;
  /** Changes an address. A question about the one before doesn't hold for it. */
  function changeAddress(set: (value: string) => void, value: string) {
    set(value);
    if (asking) connect.reset();
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-y-auto">
      <div className="drag absolute inset-x-0 top-0 h-10" />
      <form className="flex w-[26rem] flex-col py-12" onSubmit={submit}>
        <Logo className="mb-7 size-14" />
        <h1 className="mb-2 text-4xl font-semibold tracking-tight">
          {existing?.needsPassword
            ? "Enter your password again"
            : existing
              ? "Update your login"
              : "Connect your subscription"}
        </h1>
        <p className="mb-9 text-[0.9375rem] text-muted-foreground">
          {existing?.needsPassword
            ? "Your keychain no longer gives Mr. Streamer the saved password."
            : mode === "login"
              ? "Your provider's server address and login."
              : "The M3U link from your provider."}
        </p>

        {mode === "login" ? (
          <div className="space-y-4">
            <Field label="Server" note={plainHttp(server) ? UNENCRYPTED : null}>
              <Input
                value={server}
                onChange={(e) => changeAddress(setServer, e.target.value)}
                placeholder="line.example.tv:8080"
                autoFocus={!existing?.needsPassword}
              />
            </Field>
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus={existing?.needsPassword}
              />
            </Field>
          </div>
        ) : (
          <Field label="M3U link" note={plainHttp(link) && carriesLogin(link) ? UNENCRYPTED : null}>
            <Input
              value={link}
              onChange={(e) => changeAddress(setLink, e.target.value)}
              placeholder="http://line.example.tv/get.php?username=…"
              autoFocus
            />
          </Field>
        )}

        {error && <p className="mt-5 text-sm text-destructive">{error}</p>}

        {asking ? (
          <div className="mt-8">
            <p className="text-[0.9375rem]">{describeError(asking)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your username and password would travel unencrypted.
            </p>
            <div className="mt-5 flex items-center gap-3">
              <Button onClick={connectUnencrypted}>Connect without encryption</Button>
              <Button variant="ghost" onClick={() => connect.reset()}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-8 flex items-center gap-3">
            <Button type="submit" variant="primary" size="lg" disabled={connect.isPending}>
              {connect.isPending ? "Connecting…" : "Connect"}
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => setMode(mode === "login" ? "link" : "login")}
            >
              {mode === "login" ? <Link2 /> : <KeyRound />}
              {mode === "login" ? "Use an M3U link" : "Use server and login"}
            </Button>
            {existing && !existing.needsPassword && (
              <Button
                variant="ghost"
                size="lg"
                className="ml-auto"
                onClick={() => useUi.setState({ editingLogin: false })}
              >
                Cancel
              </Button>
            )}
          </div>
        )}
        <p className="mt-10 text-xs leading-relaxed text-muted-foreground/80">
          {isMac
            ? "Saved on this Mac. The password is encrypted with your macOS Keychain."
            : isWindows
              ? "Saved on this PC. The password is encrypted with your Windows account."
              : "Saved on this computer. The password is encrypted with your keyring."}
        </p>
      </form>
    </div>
  );
}

const UNENCRYPTED = "Not encrypted. Your login travels as plain text.";

/** An address typed with http://, which the login travels over unencrypted. */
function plainHttp(address: string): boolean {
  return /^http:\/\//i.test(address.trim());
}

/** Whether an M3U link names a login, as `get.php?username=…&password=…` does. */
function carriesLogin(link: string): boolean {
  const query = URL.parse(link.trim())?.searchParams;
  return !!query?.get("username") || !!query?.get("password");
}

function Field({
  label,
  note,
  children,
}: {
  label: string;
  /** A line under the control. */
  note?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm text-muted-foreground">
      {label}
      {children}
      {note && <span className="text-xs text-foreground/85">{note}</span>}
    </label>
  );
}
