import { isCollectionId } from "@mrstreamer/contracts/ondemand";
import { useLocalSearchParams } from "expo-router";
import { useLocale } from "../../../../i18n/catalogue.ts";
import { t } from "../../../../i18n/library.ts";
import { CollectionScreen } from "../../../../titles-screen.tsx";
import { Message } from "../../../../ui.tsx";

export default function SeriesCollection() {
  useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  return isCollectionId(id) ? (
    <CollectionScreen kind="series" id={id} />
  ) : (
    <Message text={t("Nothing here.")} />
  );
}
