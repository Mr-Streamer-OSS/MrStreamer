// The start page, following the approved home: the last watched channel as a large hero, then
// compact rows. Everything a viewer usually wants is one click away: watch again, pick a recent
// channel, open a category.
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, List, Play } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { Category, LiveChannel } from "../../../../shared/library.ts";
import { toDepth, useUi, type GuideDepth } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { ChannelLogo, hueOf } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { channelLine } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { queries, useCategoryMap } from "../../lib/queries.ts";
import { player } from "../../player/player.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";

const NO_IDS: readonly string[] = [];

/** Switches to Live TV, optionally starting a channel and opening guide layers. */
function goLive(options: {
  channel?: LiveChannel;
  categoryId?: string | null;
  depth?: GuideDepth;
}) {
  useUi.setState({
    view: "live",
    guideDepth: options.depth ?? toDepth(0),
    ...(options.categoryId !== undefined ? { categoryId: options.categoryId } : {}),
  });
  if (options.categoryId !== undefined) {
    void call("preferences.update", { lastCategoryId: options.categoryId }).catch(() => {});
  }
  if (options.channel) player.play(options.channel);
}

export function HomeScreen() {
  const preferences = useQuery({ ...queries.preferences(), refetchOnMount: "always" });
  const recentIds = preferences.data?.recentChannelIds ?? NO_IDS;
  const recent = useQuery(queries.channelsById(recentIds));
  const categories = useQuery(queries.categories());
  const categoryMap = useCategoryMap();
  const categoryId = useUi((state) => state.categoryId);
  const current = useQuery({ ...queries.channels(categoryId), enabled: categories.isSuccess });
  const category = categoryId ? categoryMap.get(categoryId) : undefined;
  const hero = recent.data?.[0] ?? null;
  const notice = catalogueState(categories);

  if (notice) {
    return (
      <div className="flex h-full flex-col">
        <WindowBar className="bg-black" />
        <div className="flex flex-1 items-center justify-center pb-14">
          <CatalogueNotice state={notice} />
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <WindowBar className="sticky top-0 z-20 bg-black" />
      <Hero
        channel={hero}
        pending={recentIds.length > 0 && recent.isPending}
        categories={categoryMap}
      />
      <div className="space-y-12 px-10 pt-4 pb-16">
        {recent.data && recent.data.length > 0 && (
          <Row title="Recently watched">
            {recent.data.map((channel) => (
              <ChannelTile key={channel.id} channel={channel} categories={categoryMap} />
            ))}
          </Row>
        )}
        {current.data && current.data.length > 0 && (
          <Row
            title={category ? `${category.title}` : "All channels"}
            subtitle={category?.group}
            action={
              <Button variant="ghost" size="sm" onClick={() => goLive({ depth: toDepth(2) })}>
                Open in guide
                <ChevronRight />
              </Button>
            }
          >
            {current.data.slice(0, 30).map((channel) => (
              <ChannelTile key={channel.id} channel={channel} categories={categoryMap} />
            ))}
          </Row>
        )}
        {categories.data && (
          <YourCategories
            categories={categoryMap}
            currentId={categoryId}
            recent={recent.data ?? []}
            total={categories.data.length}
          />
        )}
      </div>
    </div>
  );
}

function Hero({
  channel,
  pending,
  categories,
}: {
  channel: LiveChannel | null;
  /** The last watched channel is still loading: show the backdrop without any text yet. */
  pending: boolean;
  categories: ReadonlyMap<string, Category>;
}) {
  const hue = channel ? hueOf(channel.title) : 220;
  return (
    <section
      className="relative flex h-[58vh] min-h-[22rem] items-end overflow-hidden px-10 pb-12"
      style={{
        // The hero runs under the window bar.
        marginTop: -WINDOW_BAR.height,
        background: `radial-gradient(ellipse 70% 90% at 78% 35%, hsl(${hue} 45% 20%), transparent 70%), #000`,
      }}
    >
      {channel && (
        <ChannelLogo
          channel={channel}
          plain
          className="pointer-events-none absolute top-[24%] right-[12%] h-[28%] w-[22%] text-8xl opacity-90"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/60 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black to-transparent" />
      <div className="relative max-w-[44rem]">
        {pending ? null : channel ? (
          <>
            <div className="text-sm text-muted-foreground">
              Last watched · {channelLine(channel, categories)}
            </div>
            <h1 className="mt-2 text-6xl font-semibold tracking-tight">{channel.title}</h1>
            {channel.tags.length > 0 && (
              <div className="mt-3 text-sm text-muted-foreground">{channel.tags.join(" · ")}</div>
            )}
            <div className="mt-8 flex gap-3">
              <Button variant="primary" size="lg" onClick={() => goLive({ channel })}>
                <Play className="fill-current" />
                Watch live
              </Button>
              <Button variant="secondary" size="lg" onClick={() => goLive({ depth: toDepth(2) })}>
                <List />
                Browse channels
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-6xl font-semibold tracking-tight">Pick something to watch</h1>
            <p className="mt-4 text-lg text-muted-foreground">
              Start with a category below, or browse every channel.
            </p>
            <div className="mt-8">
              <Button variant="primary" size="lg" onClick={() => goLive({ depth: toDepth(2) })}>
                <List />
                Browse channels
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Row({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string | null | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex items-end gap-3">
        <div>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        </div>
        <div className="ml-auto">{action}</div>
      </div>
      <div className="-mx-10 flex gap-4 overflow-x-auto overscroll-x-contain px-10 pb-2">
        {children}
      </div>
    </section>
  );
}

function ChannelTile({
  channel,
  categories,
}: {
  channel: LiveChannel;
  categories: ReadonlyMap<string, Category>;
}) {
  const hue = hueOf(channel.title);
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => goLive({ channel })}
      className="group w-[13rem] flex-none text-left"
    >
      <div
        className="grid aspect-video place-items-center rounded-2xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 30% 16%), hsl(${hue} 25% 8%))` }}
      >
        <ChannelLogo channel={channel} plain className="h-[42%] w-[62%] text-2xl" />
      </div>
      <div className="mt-2.5 truncate text-[0.9375rem] font-medium">{channel.title}</div>
      <div className="truncate text-xs text-muted-foreground">
        {[channelLine(channel, categories), ...channel.tags].filter(Boolean).join(" · ")}
      </div>
    </button>
  );
}

/** How many category cards Home shows before the "All categories" card. */
const CATEGORY_CARDS = 6;

/**
 * The categories the viewer actually watches from: the current one, then those of recently
 * watched channels. Each card shows a few of its channels; the last card opens every category.
 */
function YourCategories({
  categories,
  currentId,
  recent,
  total,
}: {
  categories: ReadonlyMap<string, Category>;
  currentId: string | null;
  recent: readonly LiveChannel[];
  total: number;
}) {
  const ids = useMemo(() => {
    const ordered = [currentId, ...recent.map((channel) => channel.categoryIds[0])];
    const known = ordered.filter(
      (id): id is string => typeof id === "string" && categories.has(id),
    );
    return [...new Set(known)].slice(0, CATEGORY_CARDS);
  }, [categories, currentId, recent]);

  return (
    <Row title="Your categories">
      {ids.map((id) => {
        const category = categories.get(id);
        return category ? <CategoryCard key={id} category={category} /> : null;
      })}
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => goLive({ depth: toDepth(2) })}
        className="flex w-[15rem] flex-none flex-col justify-center gap-1 rounded-2xl bg-white/5 p-5 text-left ring-1 ring-white/8 transition-[box-shadow] duration-150 hover:ring-2 hover:ring-white/40"
      >
        <span className="text-lg font-semibold tracking-tight">All categories</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {total.toLocaleString()} categories
          <ChevronRight className="size-3.5" />
        </span>
      </button>
    </Row>
  );
}

function CategoryCard({ category }: { category: Category }) {
  const channels = useQuery(queries.channels(category.id));
  const hue = hueOf(category.title);
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => goLive({ categoryId: category.id, depth: toDepth(2) })}
      className="flex w-[15rem] flex-none flex-col gap-1.5 rounded-2xl p-5 text-left ring-1 ring-white/8 transition-[box-shadow] duration-150 hover:ring-2 hover:ring-white/40"
      style={{ background: `linear-gradient(160deg, hsl(${hue} 28% 14%), hsl(${hue} 22% 7%))` }}
    >
      {category.group && <span className="text-xs text-muted-foreground">{category.group}</span>}
      <span className="truncate text-lg font-semibold tracking-tight">{category.title}</span>
      <span className="mt-2 flex gap-2">
        {(channels.data ?? []).slice(0, 4).map((channel) => (
          <ChannelLogo key={channel.id} channel={channel} className="h-7 w-10" />
        ))}
      </span>
      <span className="mt-1 text-xs text-muted-foreground">
        {category.channelCount.toLocaleString()} channels
      </span>
    </button>
  );
}
