// About's open-source licences: every third-party component the app ships, with its licence and
// its full notice, readable offline. The build generates the list (scripts/licences.ts). A long
// notice, such as Chromium's credits, shows through a virtualised list of its lines.
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { ThirdPartyNotice } from "@mrstreamer/contracts/licences";
import { appError, describeError } from "../../lib/errors.ts";
import { queries } from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";

export function Licences() {
  const list = useQuery(queries.licences());
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (list.data ?? []).filter((notice) =>
      words.every((word) => `${notice.name} ${notice.licence}`.toLowerCase().includes(word)),
    );
  }, [list.data, query]);
  const selected = shown.find((notice) => notice.id === chosen) ?? shown[0] ?? null;

  return (
    <main className="flex min-w-0 flex-1 flex-col px-10 pt-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Open-source licences</h2>
        <span className="text-sm text-muted-foreground">
          {list.data ? `${list.data.length} components` : ""}
        </span>
      </div>
      {list.error && (
        <p className="text-sm text-destructive">{describeError(appError(list.error))}</p>
      )}
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex w-72 flex-none flex-col">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            spellCheck={false}
            className="mb-2 h-9 rounded-lg bg-white/6 px-3 text-[0.875rem] outline-none placeholder:text-muted-foreground/70 focus:bg-white/10"
          />
          <div className="min-h-0 flex-1 overflow-y-auto pb-6">
            {shown.map((notice) => (
              <button
                key={notice.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setChosen(notice.id)}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded-lg px-3 py-1.5 text-left text-[0.875rem]",
                  notice.id === selected?.id ? "bg-white/10" : "hover:bg-white/5",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{notice.name}</span>
                <span className="flex-none text-xs text-muted-foreground">{notice.licence}</span>
              </button>
            ))}
          </div>
        </div>
        {selected && <Notice notice={selected} />}
      </div>
    </main>
  );
}

function Notice({ notice }: { notice: ThirdPartyNotice }) {
  const text = useQuery(queries.licenceText(notice.id));
  const lines = useMemo(() => text.data?.split("\n") ?? [], [text.data]);
  return (
    <section className="flex min-w-0 flex-1 flex-col border-l border-border pl-6">
      <div className="text-lg font-semibold">
        {notice.name} <span className="font-normal text-muted-foreground">{notice.version}</span>
      </div>
      <div className="mt-0.5 mb-4 flex flex-wrap gap-x-3 text-[0.8125rem] text-muted-foreground">
        <span>{notice.licence}</span>
        <a
          href={notice.source}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4 hover:text-white"
        >
          Source
        </a>
        {notice.homepage && (
          <a
            href={notice.homepage}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-white"
          >
            Website
          </a>
        )}
      </div>
      {text.error && (
        <p className="text-sm text-destructive">{describeError(appError(text.error))}</p>
      )}
      <Lines lines={lines} />
    </section>
  );
}

/** A notice's text, line by line, drawing only the lines in view. */
function Lines({ lines }: { lines: readonly string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const rem = useRem();
  const lineHeight = Math.round(rem * 1.3);
  const rows = useVirtualizer({
    count: lines.length,
    getScrollElement: () => box.current,
    estimateSize: () => lineHeight,
    overscan: 30,
  });
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-auto pb-6 select-text">
      <div className="relative" style={{ height: rows.getTotalSize() }}>
        {rows.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="absolute left-0 font-mono text-[0.8125rem] whitespace-pre text-foreground/85"
            style={{ top: row.start, height: lineHeight, lineHeight: `${lineHeight}px` }}
          >
            {lines[row.index] || " "}
          </div>
        ))}
      </div>
    </div>
  );
}
