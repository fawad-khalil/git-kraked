import { useEffect, useRef, useState } from "react";
import { usePref } from "../prefs";
import { THEMES, ThemeInfo, ThemeMode, appliedTheme, pickTheme } from "./themes";

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

const OPTIONS: { value: ThemeMode; title: string; icon: React.ReactNode }[] = [
  {
    value: "system",
    title: "Match your system: light theme by day, dark theme by night",
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

const PaletteIcon = () => (
  <svg {...ICON}>
    <path d="M8 1.5a6.5 6.5 0 1 0 0 13c.9 0 1.3-.6 1.3-1.2 0-.8-.6-1.1-.6-1.8 0-.7.6-1.2 1.3-1.2h1.5a3 3 0 0 0 3-3C14.5 4 11.6 1.5 8 1.5z" />
    <circle cx="4.8" cy="7.2" r=".9" fill="currentColor" />
    <circle cx="7" cy="4.6" r=".9" fill="currentColor" />
    <circle cx="10.2" cy="4.9" r=".9" fill="currentColor" />
  </svg>
);

function Swatch({ colors }: { colors: [string, string, string] }) {
  return (
    <span className="theme-swatch" aria-hidden>
      <span style={{ background: colors[0] }} />
      <span style={{ background: colors[1] }} />
      <span style={{ background: colors[2] }} />
    </span>
  );
}

const darkQuery = () => window.matchMedia?.("(prefers-color-scheme: dark)");

/** Whether the OS is in dark mode right now; updates when it switches (e.g. at sunset). */
function useSystemDark() {
  const [dark, setDark] = useState(() => darkQuery()?.matches ?? false);
  useEffect(() => {
    const query = darkQuery();
    if (!query) return;
    const update = () => setDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return dark;
}

/**
 * System / Light / Dark, plus a palette menu choosing which theme Light and Dark use (e.g.
 * Lavender by day, Nord by night). All remembered. Sets `data-theme` on the page root.
 */
export function ThemeSwitch() {
  const [saved, setTheme] = usePref<ThemeMode>("theme", "system");
  const [lightId, setLightId] = usePref<string>("theme.light", "light");
  const [darkId, setDarkId] = usePref<string>("theme.dark", "dark");
  const systemDark = useSystemDark();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const theme: ThemeMode = saved === "light" || saved === "dark" ? saved : "system";
  const applied = appliedTheme(theme, lightId, darkId, systemDark);
  const light = pickTheme(lightId, false);
  const dark = pickTheme(darkId, true);

  useEffect(() => {
    document.documentElement.dataset.theme = applied.id;
  }, [applied.id]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const item = (t: ThemeInfo, chosen: ThemeInfo, choose: (id: string) => void) => (
    <li
      key={t.id}
      role="menuitemradio"
      aria-checked={t.id === chosen.id}
      className={t.id === chosen.id ? "on" : undefined}
      onClick={() => choose(t.id)}
    >
      <Swatch colors={t.swatch} />
      <span className="theme-name">{t.name}</span>
      <span className="theme-check" aria-hidden>
        ✓
      </span>
    </li>
  );

  return (
    <>
      <span className="segmented theme-switch" role="group" aria-label="Light or dark">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`small${theme === o.value ? " on" : ""}`}
            aria-pressed={theme === o.value}
            aria-label={o.title}
            data-tip={o.value === "system" ? o.title : `${o.value === "light" ? "Light" : "Dark"}: ${(o.value === "light" ? light : dark).name}`}
            onClick={() => setTheme(o.value)}
          >
            {o.icon}
          </button>
        ))}
      </span>
      <span className="theme-picker" ref={ref}>
        <button
          className={`icon-button${open ? " on" : ""}`}
          aria-label="Choose the light and dark themes"
          aria-haspopup="menu"
          aria-expanded={open}
          data-tip={`Themes: ${light.name} / ${dark.name}`}
          onClick={() => setOpen(!open)}
        >
          <PaletteIcon />
        </button>
        {open && (
          <ul className="menu dropdown theme-menu" role="menu">
            <li className="menu-heading" role="presentation">
              Light uses
            </li>
            {THEMES.filter((t) => !t.dark).map((t) => item(t, light, setLightId))}
            <li className="menu-heading" role="presentation">
              Dark uses
            </li>
            {THEMES.filter((t) => t.dark).map((t) => item(t, dark, setDarkId))}
          </ul>
        )}
      </span>
    </>
  );
}
