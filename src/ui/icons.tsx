// Toolbar icons: 16px line drawings in the text colour, so they follow the theme.

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const FolderOpenIcon = () => (
  <svg {...base}>
    <path d="M1.5 12.5v-8a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1V7" />
    <path d="M1.5 12.5 3.3 7.7a1 1 0 0 1 .9-.7h9.6a.6.6 0 0 1 .6.8l-1.6 4.7H1.5z" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const RefreshIcon = () => (
  <svg {...base}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2.5v3h-3" />
  </svg>
);

/** Fetch: a cloud with an arrow down. */
export const FetchIcon = () => (
  <svg {...base}>
    <path d="M4.5 11.5h-.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.8A3 3 0 0 1 12 11.5h-.5" />
    <path d="M8 7.5v6M6 11.5l2 2 2-2" />
  </svg>
);

/** Pull: an arrow down into a tray. */
export const PullIcon = () => (
  <svg {...base}>
    <path d="M8 1.5v8.5M4.5 6.5 8 10l3.5-3.5" />
    <path d="M2 11v2.5h12V11" />
  </svg>
);

/** Push: an arrow up out of a tray. */
export const PushIcon = () => (
  <svg {...base}>
    <path d="M8 10V1.5M4.5 5 8 1.5 11.5 5" />
    <path d="M2 11v2.5h12V11" />
  </svg>
);

/** Stash: put changes into a box. */
export const StashIcon = () => (
  <svg {...base}>
    <rect x="2" y="8" width="12" height="6" rx="1" />
    <path d="M8 1.5v5M6 4.5l2 2 2-2" />
  </svg>
);

/** Pop: take them back out. */
export const PopIcon = () => (
  <svg {...base}>
    <rect x="2" y="8" width="12" height="6" rx="1" />
    <path d="M8 6.5v-5M6 3.5l2-2 2 2" />
  </svg>
);

/** Cherry-pick: two cherries on a stem. */
export const CherryIcon = () => (
  <svg {...base}>
    <circle cx="4.5" cy="11.5" r="2.5" />
    <circle cx="11.5" cy="11" r="2.5" />
    <path d="M4.8 9 8.5 2.5l2.6 6M8.5 2.5c1.5-.3 3 .2 4 1.2" />
  </svg>
);

export const ChevronDownIcon = () => (
  <svg {...base} width={10} height={10}>
    <path d="M4 6l4 4 4-4" />
  </svg>
);
