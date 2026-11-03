import { SafeAreaView } from "react-native-safe-area-context";
import { sources } from "../bootstrap/sources.ts";
import { ConnectScreen } from "../connect/connect-screen.tsx";
import { colors } from "../ui/theme.ts";

/** The first source. Once it is saved the root layout shows the destinations in its place. */
export default function Connect() {
  return (
    // Edge to edge: Connect pads its own scrolling content above the navigation bar.
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <ConnectScreen owner={sources} onConnected={() => {}} />
    </SafeAreaView>
  );
}
