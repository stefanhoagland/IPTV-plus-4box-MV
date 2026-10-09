const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const SpeakerOn = () => (
  <svg {...base} aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 5a10 10 0 0 1 0 14" />
  </svg>
);

export const SpeakerOff = () => (
  <svg {...base} aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="m22 9-6 6M16 9l6 6" />
  </svg>
);

export const Fullscreen = () => (
  <svg {...base} aria-hidden="true">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);

export const Close = () => (
  <svg {...base} aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const Plus = () => (
  <svg {...base} width={36} height={36} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const FixPicture = () => (
  <svg {...base} aria-hidden="true">
    <rect x="2" y="4" width="20" height="14" rx="2" />
    <path d="M8 21h8M9 11l2 2 4-4" />
  </svg>
);
