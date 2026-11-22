/** 주소창/폼의 검색 조건(문자열)을 안전하게 IndicatorFilter로 바꾼다. 잘못된 값은 무시한다. */
import {
  INDICATOR_STATUSES,
  INDICATOR_TYPES,
  type IndicatorFilter,
  type IndicatorStatus,
  type IndicatorType,
} from "./indicator-query";

export type RawParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** "YYYY-MM-DD"를 한국 시간 0시로. 형식이 틀리거나 없는 날짜(2월 30일 등)면 undefined. */
export function kstDate(v: string | undefined, plusDays = 0): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }) !== v) return undefined;
  return new Date(d.getTime() + plusDays * 86400000);
}

export function parseIndicatorParams(sp: RawParams): { filter: IndicatorFilter; page: number } {
  const typeValues = ([] as string[]).concat(sp.type ?? []);
  const types = typeValues.filter((t): t is IndicatorType => (INDICATOR_TYPES as readonly string[]).includes(t));
  const status = first(sp.status);
  const excluded = first(sp.excluded);
  const filter: IndicatorFilter = {
    types: types.length > 0 ? [...new Set(types)] : undefined,
    status: (INDICATOR_STATUSES as readonly string[]).includes(status ?? "") ? (status as IndicatorStatus) : undefined,
    sourceName: first(sp.source)?.slice(0, 200) || undefined,
    keyword: first(sp.q)?.slice(0, 200) || undefined,
    from: kstDate(first(sp.from)),
    to: kstDate(first(sp.to), 1), // 종료일 당일 포함
    excluded: excluded === "only" || excluded === "none" ? excluded : undefined,
  };
  const page = Math.min(Math.max(Number.parseInt(first(sp.page) ?? "1", 10) || 1, 1), 100000);
  return { filter, page };
}
