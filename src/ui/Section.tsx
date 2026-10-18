import type { ReactNode } from "react";
import { usePref } from "../prefs";

interface Props {
  /** Remembers whether the section is collapsed, across restarts. */
  id: string;
  title: ReactNode;
  /** Buttons on the right of the header, e.g. Stage all. */
  actions?: ReactNode;
  heading?: "h2" | "h3";
  className?: string;
  children: ReactNode;
}

/** A titled list whose header collapses and expands it. */
export function Section({ id, title, actions, heading: Heading = "h3", className, children }: Props) {
  const [collapsed, setCollapsed] = usePref<boolean>(`collapsed.${id}`, false);
  return (
    <section className={`section${collapsed ? " collapsed" : ""}${className ? ` ${className}` : ""}`}>
      <header>
        <button
          className="section-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="chevron" aria-hidden>
            ▾
          </span>
          <Heading>{title}</Heading>
        </button>
        {actions}
      </header>
      {!collapsed && children}
    </section>
  );
}
