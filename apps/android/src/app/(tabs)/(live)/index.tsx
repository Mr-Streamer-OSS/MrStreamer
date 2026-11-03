import { useState } from "react";
import { sources } from "../../../bootstrap/sources.ts";
import { CatalogueScreen } from "../../../connect/catalogue-screen.tsx";
import { ConnectScreen } from "../../../connect/connect-screen.tsx";
import { Screen } from "../../../navigation/screen.tsx";
import { useStore } from "../../../platform/store.ts";
import { Sheet } from "../../../ui/sheet.tsx";

/** Live's root: every source's channels, with Add provider in a sheet over them. */
export default function Live() {
  const state = useStore(sources.state);
  const [adding, setAdding] = useState(false);
  const close = () => setAdding(false);

  return (
    <Screen title="Live">
      <CatalogueScreen
        owner={sources}
        sources={state.kind === "ready" ? state.sources : []}
        onAdd={() => setAdding(true)}
      />
      <Sheet visible={adding} label="Add provider" onClose={close}>
        <ConnectScreen owner={sources} onDone={close} onConnected={close} />
      </Sheet>
    </Screen>
  );
}
