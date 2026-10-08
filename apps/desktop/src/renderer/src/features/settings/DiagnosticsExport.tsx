import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../../components/ui/button.tsx";
import { call } from "../../lib/ipc.ts";

/** A local preview under About. Save uses its id, so the file exactly matches the shown text. */
export function DiagnosticsExport() {
  const opener = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [showText, setShowText] = useState(false);
  const preview = useMutation({ mutationFn: () => call("diagnostics.preview") });
  const save = useMutation({ mutationFn: (id: string) => call("diagnostics.save", { id }) });
  const report = preview.data;
  useEffect(() => {
    if (report) heading.current?.focus();
  }, [report]);
  const close = () => {
    preview.reset();
    save.reset();
    setShowText(false);
    opener.current?.focus();
  };
  return (
    <>
      <Button
        ref={opener}
        variant="secondary"
        disabled={preview.isPending}
        onClick={() => (report ? heading.current?.focus() : preview.mutate())}
      >
        {preview.isPending ? "Reading diagnostics…" : "Diagnostics…"}
      </Button>
      {report && (
        <section
          aria-label="Diagnostics export"
          className="order-last mt-4 basis-full space-y-3 text-sm"
        >
          <h2 ref={heading} tabIndex={-1} className="font-semibold outline-none">
            Diagnostics export
          </h2>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Build</dt>
            <dd>
              {report.version} · {report.channel === "nightly" ? "Nightly" : "Stable"} ·{" "}
              {report.commit.slice(0, 7)} · {report.platform} ·{" "}
              {report.distribution === "store" ? "Microsoft Store" : "Direct install"}
            </dd>
            <dt className="text-muted-foreground">Operations</dt>
            <dd>
              {report.entries} recent {report.entries === 1 ? "entry" : "entries"} ·{" "}
              {report.failures} {report.failures === 1 ? "failure" : "failures"}
            </dd>
            <dt className="text-muted-foreground">Playback</dt>
            <dd>
              Accelerated video decoding{" "}
              {report.acceleratedVideoDecodeDisabled ? "disabled" : "allowed"}
            </dd>
            <dt className="text-muted-foreground">Updates</dt>
            <dd>{report.checked === "none" ? "No check recorded" : report.checked}</dd>
            <dt className="text-muted-foreground">Subscriptions</dt>
            <dd>
              {report.subscriptions.xtream} Xtream · {report.subscriptions.m3u} M3U
            </dd>
            <dt className="text-muted-foreground">Not in it</dt>
            <dd>Addresses, logins, channel and title names, filesystem paths</dd>
          </dl>
          <p>Nothing is sent by Mr. Streamer.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => save.mutate(report.id)}
            >
              Save…
            </Button>
            <Button
              variant="ghost"
              aria-expanded={showText}
              onClick={() => setShowText((shown) => !shown)}
            >
              {showText ? "Hide the text" : "Show the text"}
            </Button>
            <Button variant="ghost" disabled={save.isPending} onClick={close}>
              Cancel
            </Button>
          </div>
          {showText && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
              {report.text}
            </pre>
          )}
          {save.isSuccess && save.data && <p role="status">Diagnostics saved.</p>}
        </section>
      )}
      {(preview.isError || save.isError) && (
        <p role="alert" className="order-last basis-full text-sm">
          {save.isError
            ? "Diagnostics could not be saved. Try again."
            : "Diagnostics could not be read."}
        </p>
      )}
    </>
  );
}
