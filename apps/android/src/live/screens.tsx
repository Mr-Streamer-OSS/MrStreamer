import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, TextInput, View } from "react-native";
import { sources } from "../bootstrap/sources.ts";
import { ConnectScreen } from "../connect/connect-screen.tsx";
import { Screen } from "../navigation/screen.tsx";
import { store, useStore } from "../platform/store.ts";
import { Sheet } from "../ui/sheet.tsx";
import { useLocale } from "./catalogue.ts";
import { t } from "./copy.ts";
import { discover, findGroups } from "./discovery.ts";
import { draftOf, identity, move, remove, resolve, type Draft, type Entry } from "./model.ts";
import { lists } from "./runtime.ts";
import { FAVOURITES } from "./store.ts";
import { Button, Channel, Content, Label, ListsSheet, NameDialog, Status } from "./ui.tsx";

const findQuery = store("");

const root = "/(tabs)/(live)" as const;

function Channels({ entries }: { entries: readonly Entry[] }) {
  const [selected, setSelected] = useState<Entry | null>(null);

  return (
    <>
      <FlatList
        data={entries}
        keyExtractor={(entry, index) => JSON.stringify([entry.sourceId, entry.channelId, index])}
        renderItem={({ item }) => <Channel entry={item} onLists={setSelected} />}
      />
      <ListsSheet entry={selected} onClose={() => setSelected(null)} />
    </>
  );
}

export function LiveScreen() {
  useLocale();
  const state = useStore(sources.state);
  const saved = useStore(lists.state);
  const params = useLocalSearchParams<{ country?: string }>();
  const [tab, setTab] = useState<"For you" | "Categories" | "All">("For you");
  const [country, setCountry] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const view = discover(state);

  const rows = params.country
    ? (view.countries.find((group) => group.name === params.country)?.rows ?? [])
    : view.rows;

  return (
    <Screen title={t("Live")}>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {(["For you", "Categories", "All"] as const).map((name) => (
          <Button
            key={name}
            title={`${tab === name ? "✓ " : ""}${t(name)}`}
            onPress={() => setTab(name)}
          />
        ))}
      </View>
      <Button title={params.country ?? t("All countries")} onPress={() => setCountry(true)} />
      <Button
        title={t("Find countries or categories")}
        onPress={() => router.push(`${root}/find`)}
      />
      <Status />
      {tab === "For you" ? (
        <Content>
          <Button title={t("Favourites")} onPress={() => router.push(`${root}/favourites`)} />
          {saved.kind === "ready" ? (
            saved.lists
              .filter((list) => list.id !== FAVOURITES)
              .map((list) => (
                <Button
                  key={list.id}
                  title={list.name}
                  onPress={() =>
                    router.push({ pathname: `${root}/list/[id]`, params: { id: list.id } })
                  }
                />
              ))
          ) : (
            <Button title={t("Try again")} onPress={lists.read} />
          )}
          <Button title={t("New list…")} onPress={() => setCreating(true)} />
        </Content>
      ) : tab === "Categories" ? (
        <Content>
          {view.categories
            .filter((group) => group.rows.some((row) => rows.includes(row)))
            .map((group) => (
              <Button
                key={group.name}
                title={`${group.name} · ${t("{count} channels", { count: group.rows.filter((row) => rows.includes(row)).length })}`}
                onPress={() =>
                  router.push({
                    pathname: `${root}/category`,
                    params: { name: group.name, country: params.country ?? "" },
                  })
                }
              />
            ))}
        </Content>
      ) : (
        <Channels entries={rows.map(identity)} />
      )}
      {!rows.length && !view.restoring && !view.loading.length && !view.failed.length ? (
        <Label>{t("Your providers list no channels.")}</Label>
      ) : null}
      <Button title={t("Add provider")} onPress={() => setAdding(true)} />
      <Sheet visible={country} label={t("Country")} onClose={() => setCountry(false)}>
        <Content>
          <Status />
          <Button
            title={t("All countries")}
            onPress={() => {
              router.setParams({ country: "" });
              setCountry(false);
            }}
          />
          {view.countries.map((group) => (
            <Button
              key={group.name}
              title={`${group.name} · ${t("{count} channels", { count: group.rows.length })}`}
              onPress={() => {
                router.setParams({ country: group.name });
                setCountry(false);
              }}
            />
          ))}
        </Content>
      </Sheet>
      <Sheet visible={adding} label={t("Add provider")} onClose={() => setAdding(false)}>
        <ConnectScreen
          owner={sources}
          onDone={() => setAdding(false)}
          onConnected={() => setAdding(false)}
        />
      </Sheet>
      {creating ? (
        <NameDialog
          visible
          title={t("New list")}
          onClose={() => setCreating(false)}
          onSave={(name) => {
            lists.create(name);
          }}
        />
      ) : null}
    </Screen>
  );
}

export function FindScreen() {
  useLocale();
  const query = useStore(findQuery);
  const setQuery = (value: string) => findQuery.set(value);
  const state = useStore(sources.state);
  const view = discover(state);
  const countries = findGroups(view.countries, query);
  const categories = findGroups(view.categories, query);

  return (
    <Screen pushed title={t("Find countries or categories")}>
      <TextInput
        accessibilityLabel={t("Countries or categories")}
        placeholder={t("Countries or categories")}
        placeholderTextColor="#A3A3A3"
        value={query}
        onChangeText={setQuery}
        style={{ color: "#FFF", minHeight: 48, padding: 12, fontSize: 18 }}
      />
      <Status />
      <Content>
        {countries.map((group) => (
          <Button
            key={group.name}
            title={`${group.name}, ${t("country")}, ${t("{count} channels", { count: group.rows.length })}`}
            onPress={() => {
              router.dismissTo({ pathname: root, params: { country: group.name } });
            }}
          />
        ))}
        {categories.map((group) => (
          <Button
            key={group.name}
            title={`${group.name}, ${t("category")}, ${t("{count} channels", { count: group.rows.length })}`}
            onPress={() =>
              router.push({ pathname: `${root}/category`, params: { name: group.name } })
            }
          />
        ))}
        {!countries.length && !categories.length ? (
          <Label>
            {t(
              view.failed.length
                ? "No country or category is called “{query}” in the channels that loaded."
                : view.loading.length || view.restoring
                  ? "No country or category is called “{query}” yet."
                  : "No country or category is called “{query}”.",
              { query },
            )}
          </Label>
        ) : null}
      </Content>
    </Screen>
  );
}

export function CategoryScreen() {
  useLocale();
  const { name = "", country = "" } = useLocalSearchParams<{ name: string; country?: string }>();
  const view = discover(useStore(sources.state));
  const group = view.categories.find((group) => group.name === name);

  const allowed = country
    ? (view.countries.find((group) => group.name === country)?.rows ?? [])
    : view.rows;

  return (
    <Screen pushed title={name}>
      <Status />
      {group ? (
        <Channels entries={group.rows.filter((row) => allowed.includes(row)).map(identity)} />
      ) : (
        <Label>{t("This category isn't listed any more.")}</Label>
      )}
    </Screen>
  );
}

export function ListScreen({ favourites = false }: { favourites?: boolean }) {
  useLocale();
  const { id: param = "" } = useLocalSearchParams<{ id: string }>();
  const id = favourites ? FAVOURITES : param;
  const state = useStore(lists.state);
  const providers = useStore(sources.state);
  const list = state.kind === "ready" ? state.lists.find((each) => each.id === id) : undefined;
  const name = favourites ? t("Favourites") : (list?.name ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [savingFailed, setSavingFailed] = useState(false);

  // Screen closes its edit pane before either Back can pop the list route.
  const close = () => {
    setDraft(null);
    setSavingFailed(false);
  };

  const save = () => {
    if (!draft) return;

    try {
      lists.commit(draft);
      close();
    } catch (cause) {
      if (cause instanceof Error && cause.message === "stale")
        Alert.alert(
          t("{name} changed", { name }),
          t("Nothing was moved or removed. It changed while you edited it: edit it as it is now."),
        );
      else setSavingFailed(true);
    }
  };

  const editContent = draft ? (
    <Content>
      <Status />
      <Button title={t("Close")} onPress={close} />
      <Button title={t("Save")} onPress={save} />
      {savingFailed ? (
        <>
          <Label>{t("Couldn't save {name}", { name })}</Label>
          <Button title={t("Try again")} onPress={save} />
        </>
      ) : null}
      {draft.entries.map((entry, index) => (
        <View key={JSON.stringify([entry.sourceId, entry.channelId])}>
          <Label>
            {t("{name}, {position} of {count}", {
              name: entry.title,
              position: index + 1,
              count: draft.entries.length,
            })}
          </Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            <Button
              title={t("Move {name} up", { name: entry.title })}
              disabled={index === 0}
              onPress={() => setDraft(move(draft, index, -1))}
            />
            <Button
              title={t("Move {name} down", { name: entry.title })}
              disabled={index === draft.entries.length - 1}
              onPress={() => setDraft(move(draft, index, 1))}
            />
            {resolve(entry, providers).kind === "listed" ||
            resolve(entry, providers).kind === "missing" ||
            resolve(entry, providers).kind === "removed" ? (
              <Button
                title={t("Remove from {list}", { list: name })}
                onPress={() => setDraft(remove(draft, index))}
              />
            ) : null}
          </View>
        </View>
      ))}
      {!favourites ? (
        <>
          <Button title={t("Rename list")} onPress={() => setRenaming(true)} />
          <Button
            title={t("Delete list")}
            onPress={() =>
              Alert.alert(t("Delete {name}?", { name }), t("Its channels stay in Live."), [
                { text: t("Cancel"), style: "cancel" },
                {
                  text: t("Delete"),
                  style: "destructive",
                  onPress: () => {
                    try {
                      lists.delete(id);
                      close();
                      router.back();
                    } catch {
                      setSavingFailed(true);
                    }
                  },
                },
              ])
            }
          />
        </>
      ) : null}
    </Content>
  ) : null;

  return (
    <Screen
      pushed
      title={name}
      detail={draft ? { title: name, content: editContent, onClose: close } : undefined}
    >
      <Status />
      {state.kind === "failed" ? (
        <>
          <Label>{t("Couldn't read your lists.")}</Label>
          <Button title={t("Try again")} onPress={lists.read} />
        </>
      ) : !list ? (
        <Label>{t("This list was deleted.")}</Label>
      ) : (
        <>
          <Button title={t("Edit")} onPress={() => setDraft(draftOf(list, providers))} />
          {!list.entries.length ? (
            <Label>
              {favourites ? t("No favourites yet.") : t("No channels in {name}.", { name })}
            </Label>
          ) : null}
          <Channels entries={list.entries} />
        </>
      )}
      {renaming ? (
        <NameDialog
          visible
          initial={name}
          title={t("Rename list")}
          onClose={() => setRenaming(false)}
          onSave={(next) => lists.rename(id, next)}
        />
      ) : null}
    </Screen>
  );
}
