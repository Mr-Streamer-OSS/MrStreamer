import type { ReactNode } from "react";

/** One part of the title's CC panel: its name, what stands beside it, and its controls. */
export function PanelSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-4 border-t border-white/20 pt-3 text-sm">
      <div className="mb-1 flex min-h-7 items-center gap-2">
        <h3 className="flex-1 font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}
