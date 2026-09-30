import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import {
  syncGuideUpdates,
  syncLibraryUpdates,
  syncOnDemand,
  syncUpdates,
  syncViewing,
} from "./lib/queries.ts";
import "./styles.css";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
syncLibraryUpdates(client);
syncOnDemand(client);
syncGuideUpdates(client);
syncViewing(client);
syncUpdates(client);

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <TooltipProvider delay={400}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
