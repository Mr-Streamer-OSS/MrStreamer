import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/** A real renderer tree with its own container. Call unmount before restoring timers or mocks. */
export function queryView(client: QueryClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: (node?: ReactNode) =>
      act(async () => root.render(createElement(QueryClientProvider, { client }, node))),
    unmount() {
      act(() => root.unmount());
      client.clear();
      container.remove();
    },
  };
}
