// The pieces the profile menu and Manage profiles share: a profile's avatar and name, the PIN
// field and its prompt, and a failure with Retry.
import type { KeyboardEvent, RefObject } from "react";
import { DEFAULT_PROFILE_ID, type LocalProfile } from "@mrstreamer/contracts/profiles";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";

/** A PIN is 4 to 12 digits, as main checks. */
export const PIN_MIN = 4;
const PIN_MAX = 12;

/** Default is the app's own profile, named in the window's language rather than stored words. */
export const nameOf = (profile: LocalProfile) =>
  profile.id === DEFAULT_PROFILE_ID ? t("Default") : profile.name;

/** Avatar fills from Paper A, one per profile id, so a profile keeps its colour across lists. */
const FILLS = ["#2E5E4E", "#5E3A2E", "#3A3A6E"] as const;

export function Avatar({ profile }: { profile: LocalProfile | undefined }) {
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

/**
 * A PIN field for one change: digits only, never filled in or remembered by the browser. Escape
 * cancels the change, not the menu. `wrong` says the last PIN tried was refused.
 */
export function PinPrompt({
  field,
  prompt,
  action,
  busy,
  wrong,
  pin,
  onPin,
  onSubmit,
  onCancel,
}: {
  field: RefObject<HTMLInputElement | null>;
  prompt: string;
  action: string;
  busy: boolean;
  wrong: boolean;
  pin: string;
  onPin: (pin: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="px-2 py-1.5"
    >
      <p className="pb-2">{prompt}</p>
      <div className="flex items-center gap-2">
        <PinInput
          ref={field}
          label={t("PIN")}
          value={pin}
          onChange={onPin}
          invalid={wrong}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !onCancel) return;
            event.stopPropagation();
            onCancel();
          }}
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          aria-disabled={!pin || undefined}
          aria-busy={busy || undefined}
        >
          {action}
        </Button>
      </div>
      {wrong && (
        <p role="alert" className="pt-2">
          {t("Kids policy: enter the correct PIN.")}
        </p>
      )}
    </form>
  );
}

/** A masked field that keeps only the digits a PIN can have, up to 12. */
export function PinInput({
  ref,
  label,
  value,
  onChange,
  invalid = false,
  onKeyDown,
}: {
  ref?: RefObject<HTMLInputElement | null>;
  label: string;
  value: string;
  onChange: (pin: string) => void;
  invalid?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <Input
      ref={ref}
      compact
      type="password"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      placeholder={label}
      aria-invalid={invalid || undefined}
      maxLength={PIN_MAX}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, PIN_MAX))}
      onKeyDown={onKeyDown}
    />
  );
}

/** What a failed read or change came to, with Retry. */
export function Failure({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 px-2 py-1.5">
      <span className="min-w-0 flex-1">{text}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t("Retry")}
      </Button>
    </div>
  );
}
