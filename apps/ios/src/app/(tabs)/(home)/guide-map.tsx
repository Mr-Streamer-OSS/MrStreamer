import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { GuideMapEditor, GuideMapScreen } from "../../../guides-screen.tsx";

/**
 * Map channels from Settings' Guides: every channel and its guide id, or one channel's mapping
 * when `channel` names its key. Pushed on the stack Settings is on.
 */
export default function GuideMap() {
  const params = useLocalSearchParams<{ channel?: string | string[] }>();
  const channel = Array.isArray(params.channel) ? params.channel[0] : params.channel;
  const navigation = useNavigation();
  useLayoutEffect(() => {
    // A channel's mapping carries its own large title.
    navigation.setOptions({ title: channel ? "" : "Map channels" });
  }, [navigation, channel]);
  return channel ? <GuideMapEditor key={channel} channelKey={channel} /> : <GuideMapScreen />;
}
