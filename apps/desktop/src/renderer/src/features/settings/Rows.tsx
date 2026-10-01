// The pieces Settings is built from: titled lists of rows, each with its name on the left and
// its control or value on the right, like the system's own settings.
import type { ReactNode } from "react";

/** A titled list of rows. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-1 text-[0.9375rem] font-semibold">{title}</h2>
      <div className="text-[0.9375rem]">{children}</div>
    </section>
  );
}

/** One setting: its name, a few words beside it, and its control on the right. */
export function Row({
  label,
  note,
  children,
}: {
  label: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-13 items-center gap-6 border-b border-white/8 py-2">
      <div className="min-w-0 flex-1 truncate">
        {label}
        {note && <span className="text-muted-foreground"> · {note}</span>}
      </div>
      {children && <div className="flex flex-none items-center gap-2">{children}</div>}
    </div>
  );
}

/** A choice from a short list, on the right of its row. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => {
        const picked = options.find((option) => option.value === event.target.value);
        if (picked) onChange(picked.value);
      }}
      className="h-9 w-56 rounded-lg bg-white/6 px-3 ring-1 ring-input outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
