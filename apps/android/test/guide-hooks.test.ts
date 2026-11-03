// @vitest-environment happy-dom
import { act, createElement } from "react";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";

// Android has no DOM types or renderer dependency; Vitest shares the desktop React install.
const { document } = new Window();
const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: ReturnType<typeof document.createElement>): {
    render(node: unknown): void;
    unmount(): void;
  };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const service = vi.hoisted(() => ({ schedule: vi.fn(), programmeAt: vi.fn() }));

vi.mock("../src/bootstrap/sources.ts", () => ({ sources: {} }));

vi.mock("../src/guide/runtime.ts", () => ({ startGuide: async () => {} }));

vi.mock("../src/guide/guide-sources.ts", () => ({ guides: {} }));

vi.mock("../src/guide/guide.ts", () => ({
  guide: {
    ...service,
    listingRevision: { subscribe: () => () => {}, get: () => 0 },
    withdrawals: { subscribe: () => () => {} },
    withdrawn: () => 0,
    programmeStatus: () => null,
  },
}));

import { useProgramme, useSchedule } from "../src/guide/hooks.ts";

// A component displays each hook's public state, with its public retry wired to a button.
it("keeps shown schedule rows on failure and makes the read retryable", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const day = { from: 1, until: 2 };
  service.schedule.mockResolvedValue({ programmes: [{ title: "News" }], cursor: null });

  function Schedule() {
    const read = useSchedule("source:1", day);

    return createElement(
      "button",
      { onClick: read.retry },
      `${read.failed ? "Failed" : "Ready"}: ${read.programmes.map((p) => p.title).join()}`,
    );
  }

  try {
    await act(async () => root.render(createElement(Schedule)));
    expect(container.textContent).toBe("Ready: News");
    service.schedule.mockRejectedValue(new Error("disk"));
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("Failed: News");
    service.schedule.mockResolvedValue({ programmes: [{ title: "Updated" }], cursor: null });
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("Ready: Updated");
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows unknown programme reads as failed and retries rather than declaring absence", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  service.programmeAt.mockResolvedValue(undefined);

  function Programme() {
    const read = useProgramme("source:1", 1);

    return createElement(
      "button",
      { onClick: read.retry },
      read.failed ? "Failed" : (read.value?.title ?? "Absent"),
    );
  }

  try {
    await act(async () => root.render(createElement(Programme)));
    expect(container.textContent).toBe("Failed");
    service.programmeAt.mockResolvedValue({ title: "News" });
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("News");
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps a programme failure visible during retry until the replacement read settles", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let finish!: (value: { title: string }) => void;
  service.programmeAt.mockRejectedValueOnce(new Error("disk"));

  function Programme() {
    const read = useProgramme("source:1", 1);

    return createElement(
      "button",
      { onClick: read.retry },
      read.failed ? "Failed" : read.pending ? "Loading" : (read.value?.title ?? "Absent"),
    );
  }

  try {
    await act(async () => root.render(createElement(Programme)));
    expect(container.textContent).toBe("Failed");
    service.programmeAt.mockReturnValueOnce(
      new Promise<{ title: string }>((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("Failed");
    await act(async () => finish({ title: "News" }));
    expect(container.textContent).toBe("News");
  } finally {
    await act(async () => root.unmount());
  }
});

it("ignores an older programme response after the selected programme fails", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let finish!: (value: { title: string }) => void;
  service.programmeAt.mockReturnValueOnce(
    new Promise<{ title: string }>((resolve) => {
      finish = resolve;
    }),
  );

  function Programme({ start }: { start: number }) {
    const read = useProgramme("source:1", start);

    return createElement(
      "span",
      null,
      read.failed ? "Failed" : read.pending ? "Loading" : (read.value?.title ?? "Absent"),
    );
  }

  try {
    await act(async () => root.render(createElement(Programme, { start: 1 })));
    expect(container.textContent).toBe("Loading");
    service.programmeAt.mockRejectedValueOnce(new Error("disk"));
    await act(async () => root.render(createElement(Programme, { start: 2 })));
    expect(container.textContent).toBe("Failed");
    await act(async () => finish({ title: "Old news" }));
    expect(container.textContent).toBe("Failed");
    service.programmeAt.mockResolvedValueOnce({ title: "New news" });
    await act(async () => root.render(createElement(Programme, { start: 3 })));
    expect(container.textContent).toBe("New news");
  } finally {
    await act(async () => root.unmount());
  }
});
