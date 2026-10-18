import { useEffect, useRef, useState } from "react";
import { usePref } from "../prefs";
import { THEMES, ThemeChoice, ThemeInfo, resolveTheme } from "./themes";

const PaletteIcon = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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

/** The toolbar's theme picker: follow the system, or pick a light or dark theme. Remembered. */
export function ThemeSwitch() {
  const [choice, setChoice] = usePref<ThemeChoice>("theme", "system");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const current = resolveTheme(choice);

  useEffect(() => {
    const root = document.documentElement;
    if (current) root.dataset.theme = current.id;
    else delete root.dataset.theme;
  }, [current]);

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

  const item = (id: ThemeChoice, label: string, theme: ThemeInfo | null) => (
    <li
      key={id}
      role="menuitemradio"
      aria-checked={choice === id || (id === "system" && !current)}
      className={choice === id || (id === "system" && !current) ? "on" : undefined}
      onClick={() => {
        setChoice(id);
        setOpen(false);
      }}
    >
      {theme ? <Swatch colors={theme.swatch} /> : <span className="theme-swatch system" aria-hidden />}
      <span className="theme-name">{label}</span>
      <span className="theme-check" aria-hidden>
        ✓
      </span>
    </li>
  );

  return (
    <span className="theme-picker" ref={ref}>
      <button
        className={`icon-button${open ? " on" : ""}`}
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={`Theme: ${current ? current.name : "match system"}`}
        onClick={() => setOpen(!open)}
      >
        <PaletteIcon />
      </button>
      {open && (
        <ul className="menu dropdown theme-menu" role="menu">
          {item("system", "Match system (Light or Dark)", null)}
          <li className="menu-heading" role="presentation">
            Light
          </li>
          {THEMES.filter((t) => !t.dark).map((t) => item(t.id, t.name, t))}
          <li className="menu-heading" role="presentation">
            Dark
          </li>
          {THEMES.filter((t) => t.dark).map((t) => item(t.id, t.name, t))}
        </ul>
      )}
    </span>
  );
}
