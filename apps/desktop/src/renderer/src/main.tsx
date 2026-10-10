import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { syncDownloads } from "./lib/downloads.ts";
import { loadLanguage, useLocale } from "./app/language.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import {
  syncGuideUpdates,
  syncLibraryUpdates,
  syncOnDemand,
  syncUpdates,
  syncViewing,
  syncWatchlist,
} from "./lib/queries.ts";
import "./styles.css";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
syncLibraryUpdates(client);
syncOnDemand(client);
syncGuideUpdates(client);
syncViewing(client);
syncWatchlist(client);
syncUpdates(client);
syncDownloads(client);

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

/** The app, rendered again whole when the interface language changes. */
function Root() {
  useLocale();
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delay={400}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

await loadLanguage(client);
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
