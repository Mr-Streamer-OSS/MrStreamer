/** `fields` without its undefined values, each kept field optional. */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Copies `fields` without the ones that are undefined, so an optional property is left out rather
 * than set to undefined, as `exactOptionalPropertyTypes` asks. Spread it where the object is built:
 * `{ id, ...defined({ logo, rating }) }` has `logo` and `rating` only when they have a value.
 */
export function defined<T extends object>(fields: T): Defined<T> {
  const kept: Defined<T> = {};

  for (const key in fields) {
    const value = fields[key];

    // TypeScript does not narrow a generic field by the check, so it is told what the check proved.
    if (value !== undefined) kept[key] = value as Exclude<T[typeof key], undefined>;
  }

  return kept;
}
