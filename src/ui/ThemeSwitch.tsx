import { useEffect } from "react";
import { usePref } from "../prefs";

export type Theme = "system" | "light" | "dark";

const ICON = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const OPTIONS: { value: Theme; title: string; icon: React.ReactNode }[] = [
  {
    value: "system",
    title: "Theme: match your system's light or dark setting",
    icon: (
      <svg {...ICON}>
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
        <path d="M5.5 14h5M8 11.5V14" />
      </svg>
    ),
  },
  {
    value: "light",
    title: "Theme: light",
    icon: (
      <svg {...ICON}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
      </svg>
    ),
  },
  {
    value: "dark",
    title: "Theme: dark",
    icon: (
      <svg {...ICON}>
        <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" />
      </svg>
    ),
  },
];

/** System / Light / Dark, remembered. Sets `data-theme` on the page root, which the CSS reads. */
export function ThemeSwitch() {
  const [theme, setTheme] = usePref<Theme>("theme", "system");
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
  return (
    <span className="segmented theme-switch" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          className={`small${theme === o.value ? " on" : ""}`}
          aria-pressed={theme === o.value}
          aria-label={o.title}
          data-tip={o.title}
          onClick={() => setTheme(o.value)}
        >
          {o.icon}
        </button>
      ))}
    </span>
  );
}
