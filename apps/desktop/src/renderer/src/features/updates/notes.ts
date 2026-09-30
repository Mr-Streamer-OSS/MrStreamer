// Release notes as the release workflow writes them (scripts/release-plan.ts notes): a heading, one
// line per pull request, "* Title by @author in https://github.com/owner/repo/pull/12", and a
// changelog link. The views show the titles, each linked to its pull request.

export interface NoteItem {
  readonly text: string;
  /** The pull request's page, when the line names one. */
  readonly url: string | null;
  /** "#12" */
  readonly label: string | null;
}

export function noteItems(markdown: string | null): NoteItem[] {
  if (!markdown) return [];
  return markdown.split("\n").flatMap((line): NoteItem[] => {
    const item = /^\s*[*-]\s+(.+)$/.exec(line)?.[1];
    if (!item) return [];
    const pull = /^(.*?)\s+by\s+@\S+\s+in\s+(https:\/\/\S+\/pull\/(\d+))\s*$/.exec(item);
    if (pull?.[1] && pull[2] && pull[3]) {
      return [{ text: pull[1], url: pull[2], label: `#${pull[3]}` }];
    }
    return [{ text: item.replace(/\*\*/g, ""), url: null, label: null }];
  });
}
