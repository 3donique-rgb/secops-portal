/** 목록 쪽 나누기 공통 계산 (위협정보·자산 화면) */
export const PAGE_SIZES = [10, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
/** 쪽 번호를 한 번에 보여 주는 개수 (1~10, 11~20 ...) */
export const WINDOW = 10;

/** ?size= 값을 10·50·100 중 하나로 맞춘다. 그 밖의 값은 기본값 */
export function parsePageSize(v: string | string[] | undefined, fallback: PageSize): PageSize {
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number(s);
  return (PAGE_SIZES as readonly number[]).includes(n) ? (n as PageSize) : fallback;
}

/** ?page= 값을 1 이상의 정수로 맞춘다 */
export function parsePage(v: string | string[] | undefined): number {
  const s = Array.isArray(v) ? v[0] : v;
  const n = Math.trunc(Number(s));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1_000_000) : 1;
}

export function totalPages(total: number, size: number): number {
  return Math.max(Math.ceil(total / size), 1);
}

/** 현재 쪽이 속한 10쪽 묶음의 번호들. 예) 7쪽 → 1..10, 13쪽 → 11..20 (마지막 쪽을 넘지 않음) */
export function pageWindow(page: number, pages: number): { numbers: number[]; prevGroup: number | null; nextGroup: number | null } {
  const g = Math.floor((Math.min(Math.max(page, 1), pages) - 1) / WINDOW);
  const first = g * WINDOW + 1;
  const last = Math.min(first + WINDOW - 1, pages);
  const numbers: number[] = [];
  for (let i = first; i <= last; i++) numbers.push(i);
  return { numbers, prevGroup: g > 0 ? first - 1 : null, nextGroup: last < pages ? last + 1 : null };
}

/** 쪽 크기를 바꿀 때, 지금 보던 첫 항목이 있는 쪽으로 이동 */
export function pageAfterSizeChange(page: number, oldSize: number, newSize: number): number {
  return Math.floor(((page - 1) * oldSize) / newSize) + 1;
}

/** 화면에 보여 줄 "시작–끝" 번호 */
export function rangeLabel(page: number, size: number, total: number): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  const from = (page - 1) * size + 1;
  return { from, to: Math.min(page * size, total) };
}
