interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

/** A small search box above a sidebar list; Escape clears it. */
export function ListFilter({ value, onChange, placeholder }: Props) {
  return (
    <input
      className="section-filter"
      type="search"
      placeholder={placeholder}
      aria-label={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Escape" && onChange("")}
      spellCheck={false}
    />
  );
}

/** Whether `name` contains every word of `query`, ignoring case. */
export function matchesFilter(name: string, query: string) {
  const lower = name.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => lower.includes(word));
}
