// People and film franchises (#864, PR #875), as a journey:
// xvfb-run -a pnpm verify:desktop journey .cursor/skills/verify-mrstreamer/scripts/people.ts
// The fake provider's "TEST | Two sound tracks" film shows as TMDB's Original 100000. Its cast
// member Alan Actor (TMDB person 1) leads to the four titles the provider lists of his credits,
// newest first; its franchise Test Saga (collection 10) to two films, in release order. A listed
// title opens its details, Back returns to the list with the keyboard on it, then to the film's
// details with the keyboard on the link. Names come from `apps/desktop/test/fake-tmdb.ts`.
import type { Journey } from "./journey.ts";

const people: Journey = async (d, { tmdb, named, poster, dialog, focused }) => {
  const back = named("header button", "Back", dialog);
  const says = (words: string) => `(${dialog})?.innerText.includes(${JSON.stringify(words)})`;
  const tile = (name: string) => named("li button", name, dialog);

  /** Waits for the keyboard on `target`, failing with what has it instead. */
  const expectFocus = async (target: string, what: string) => {
    try {
      await d.wait(() => d.evaluate<boolean>(`document.activeElement === (${target})`), 10_000);
    } catch (error) {
      throw new Error(`The keyboard is not on ${what}: ${await d.evaluate<string>(focused)}.`, {
        cause: error,
      });
    }
  };

  /** The shown names of the list's posters, in order. */
  const listed = () =>
    d.evaluate<string[]>(
      `[...((${dialog})?.querySelectorAll('li button') ?? [])].map(b => b.querySelector('span.truncate')?.textContent.trim() ?? b.innerText)`,
    );

  const open = async (label: string, element: string, shows: string) => {
    await d.click(label, element);
    await d.wait(() => d.exists(says(shows)));
  };

  await d.click("Open Movies", named("header button", "Movies"));
  await d.click("Open All movies", named("nav button", "All movies"));
  await open(
    "Open Two sound tracks",
    poster("Two sound tracks"),
    "TMDB's story of Original 100000.",
  );
  await d.capture("details");

  await open(
    "Open Alan Actor",
    named("button", "Alan Actor", dialog),
    "4 in your subscriptions, newest first",
  );
  d.observed["personTitles"] = await listed();
  await d.capture("person");

  await open("Open English 100002", tile("English 100002"), "TMDB's story of English 100002.");
  await d.capture("person-title");

  await open("Back to Alan Actor", back, "4 in your subscriptions, newest first");
  await expectFocus(tile("English 100002"), "English 100002 after Back");
  await open("Back to Original 100000", back, "TMDB's story of Original 100000.");
  await expectFocus(named("button", "Alan Actor", dialog), "Alan Actor after Back");
  await d.capture("back-to-details");

  await open(
    "Open Test Saga",
    named("button", "Part of Test Saga", dialog),
    "2 in your subscriptions, in release order",
  );
  d.observed["franchiseTitles"] = await listed();
  await d.capture("franchise");

  await open("Open Original 100004", tile("Original 100004"), "TMDB's story of Original 100004.");
  await d.capture("franchise-title");
  await open("Back to Test Saga", back, "2 in your subscriptions, in release order");
  await expectFocus(tile("Original 100004"), "Original 100004 after Back");
  await open("Back to Original 100000", back, "TMDB's story of Original 100000.");
  await expectFocus(named("button", "Part of Test Saga", dialog), "Test Saga after Back");

  d.observed["linkedRequests"] = [...tmdb.linkedRequests()];

  const expected = {
    personTitles: ["Origineel 90000", "Original 100003", "English 100002", "Origineel 100005"],
    franchiseTitles: ["Original 100000", "Original 100004"],
    linkedRequests: ["person/1", "collection/10"],
  };

  for (const [key, value] of Object.entries(expected))
    if (JSON.stringify(d.observed[key]) !== JSON.stringify(value))
      throw new Error(
        `${key} were ${JSON.stringify(d.observed[key])}, not ${JSON.stringify(value)}.`,
      );
};

export default people;
