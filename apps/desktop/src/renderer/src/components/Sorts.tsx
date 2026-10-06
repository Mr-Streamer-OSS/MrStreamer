/** Orders to pick from, as words in a row; none pressed while a list shows in its own order. */
export function Sorts<S extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { readonly value: S; readonly label: string }[];
  value: S | null;
  onChange: (sort: S) => void;
}) {
  return (
    <div className="mb-4 flex gap-5 text-[0.8125rem]">
      {options.map((entry) => (
        <button
          key={entry.value}
          aria-pressed={entry.value === value}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange(entry.value)}
          className={
            entry.value === value
              ? "font-semibold text-white"
              : "text-muted-foreground hover:text-white"
          }
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
