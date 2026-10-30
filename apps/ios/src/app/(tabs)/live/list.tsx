import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { ChannelListScreen } from "../../../custom-lists-screen.tsx";
import { useChannelLists } from "../../../custom-lists.ts";

/**
 * One of the viewer's channel lists, by its id (`listHref` in custom-lists-screen.tsx), titled
 * with its name.
 */
export default function LiveList() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const name = useChannelLists().find((list) => list.id === id)?.name ?? "";
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);
  return <ChannelListScreen id={id} />;
}
