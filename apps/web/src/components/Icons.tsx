/**
 * Inline icons. Twenty lines of SVG instead of an icon package -- the bundle
 * ships to a free-tier host on every load, and six glyphs are not worth a
 * dependency.
 */
type Props = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const IconOverview = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </svg>
);

export const IconTickers = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M2 13h12" />
    <path d="M4 13V8M7.3 13V4.5M10.6 13V9.5M14 13V6" />
  </svg>
);

export const IconSpikes = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M1.5 11.5l3-6 2.5 4L9.5 3l2 8.5" />
    <path d="M1.5 14h13" />
  </svg>
);

export const IconScoring = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
    <circle cx="8" cy="8" r="3" />
  </svg>
);

export const IconWatchlist = ({ size = 15 }: Props) => (
  <svg {...base(size)}>
    <path d="M8 2l1.8 3.7 4.2.6-3 3 .7 4.1L8 11.5 4.3 13.4l.7-4.1-3-3 4.2-.6z" />
  </svg>
);

export const IconSearch = ({ size = 13 }: Props) => (
  <svg {...base(size)}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);

export const IconBack = ({ size = 13 }: Props) => (
  <svg {...base(size)}>
    <path d="M10 3L5 8l5 5" />
  </svg>
);

export const IconExternal = ({ size = 11 }: Props) => (
  <svg {...base(size)}>
    <path d="M6.5 3H3v10h10V9.5" />
    <path d="M9.5 2.5H13.5V6.5M13.5 2.5L7.5 8.5" />
  </svg>
);
