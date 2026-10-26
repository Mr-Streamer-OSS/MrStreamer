import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/** A real renderer tree with its own container in the page. Call unmount before restoring timers or mocks. */
export function bareView() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: (node?: ReactNode) => act(async () => root.render(node)),
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** A bare view whose tree has `client`, cleared once it unmounts. */
export function queryView(client: QueryClient) {
  const mounted = bareView();
  return {
    container: mounted.container,
    render: (node?: ReactNode) =>
      mounted.render(createElement(QueryClientProvider, { client }, node)),
    unmount() {
      mounted.unmount();
      client.clear();
    },
  };
}
