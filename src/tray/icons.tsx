const PATHS = {
  note: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 15h5M10 18h3",
  vault: "M4 7h6l2 2h8v10H4z",
  search: "M11 11m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M16 16l4 4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
