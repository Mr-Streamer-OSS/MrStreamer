/** In-memory Documents stand-in shared by the multi-provider tests. State belongs to each file
 * and survives its app-module relaunches; synchronous full-disk faults leave async writes alone. */
export function memoryFiles(memory: { files: Map<string, string>; full: Set<string> }) {
  const pathOf = (parent: string | { readonly path: string }, name: string) =>
    `${typeof parent === "string" ? parent : parent.path}/${name}`;
  class Directory {
    readonly path: string;
    constructor(parent: string | Directory, name: string) {
      this.path = pathOf(parent, name);
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      const within = `${this.path}/`;
      return [...memory.files.keys()]
        .filter((path) => path.startsWith(within) && !path.slice(within.length).includes("/"))
        .map((path) => new File(this, path.slice(within.length)));
    }
  }
  class File {
    path: string;
    constructor(parent: string | Directory, name: string) {
      this.path = pathOf(parent, name);
    }
    get name() {
      return this.path.slice(this.path.lastIndexOf("/") + 1);
    }
    get exists() {
      return memory.files.has(this.path);
    }
    get size() {
      return memory.files.get(this.path)?.length ?? 0;
    }
    get modificationTime() {
      return 0;
    }
    create() {
      if (!this.exists) memory.files.set(this.path, "");
    }
    textSync() {
      const text = memory.files.get(this.path);
      if (text === undefined) throw new Error("No such file");
      return text;
    }
    async text() {
      return this.textSync();
    }
    writeSync(text: string) {
      if ([...memory.full].some((name) => this.path.endsWith(`/${name}.next`))) {
        throw new Error("The disk is full");
      }
      memory.files.set(this.path, text);
    }
    async write(text: string) {
      memory.files.set(this.path, text);
    }
    moveSync(to: File) {
      memory.files.set(to.path, this.textSync());
      memory.files.delete(this.path);
    }
    async move(to: File) {
      this.moveSync(to);
      this.path = to.path;
    }
    delete() {
      memory.files.delete(this.path);
    }
  }
  return { File, Directory, Paths: { document: "/documents", cache: "/cache" } };
}
