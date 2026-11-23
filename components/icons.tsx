/** 메뉴·버튼에 쓰는 선 아이콘 (외부 패키지 없이 SVG 직접 사용). 글자 색을 따라간다. */
const PATHS = {
  dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  shield: "M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6l8-3zM9 12l2 2 4-4",
  report: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  users: "M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1a4 4 0 00-3-3.9M16 4.2a3.5 3.5 0 010 6.6",
  rss: "M5 5a14 14 0 0114 14M5 11a8 8 0 018 8M6 19h.01",
  check: "M4 12l5 5L20 6",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4",
  log: "M8 4h11v16H8zM8 4H5v16h3M12 9h4M12 13h4",
  bell: "M6 16V11a6 6 0 1112 0v5l2 2H4zM10 21h4",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
  logout: "M9 4H5v16h4M16 8l4 4-4 4M20 12H9",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  trend: "M3 17l6-6 4 4 8-8M15 7h6v6",
  alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  news: "M4 5h13a1 1 0 011 1v12a2 2 0 002 2H6a2 2 0 01-2-2V5zm14 4h2v9a2 2 0 01-2 2M7 9h7M7 13h7M7 16h4",
  tool: "M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.4 2.4-2.6-.6-.6-2.6z",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
