import Link from "next/link";
import { getDb } from "@/db";
import { parseIndicatorParams, type RawParams } from "@/lib/indicator-params";
import { INDICATOR_TYPES, listSourceNames, searchIndicators } from "@/lib/indicator-query";
import { VerdictBadge } from "@/components/verdict-badge";
import { TYPE_LABEL } from "@/lib/labels";
import { latestVerdicts } from "@/lib/reputation";
import { CountryFlag } from "@/components/country-flag";
import { countryName, geoForIndicators, type GeoRow } from "@/lib/geo";
import { requireUser } from "@/lib/session";

export const metadata = { title: "위협정보 - 보안관제 포털" };

const PAGE_SIZE = 50;
const fmt = (d: Date) => d.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });

export default async function IndicatorsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requireUser();
  const sp = await searchParams;
  const { filter, page } = parseIndicatorParams(sp);
  const db = getDb();
  const [{ rows, total }, sourceNames] = await Promise.all([
    searchIndicators(db, filter, { page, pageSize: PAGE_SIZE }),
    listSourceNames(db),
  ]);
  const verdicts = await latestVerdicts(db, rows.map((r) => r.id));
  const geo = await geoForIndicators(db, rows);
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const pageHref = (p: number) => {
    const u = new URLSearchParams();
    for (const t of filter.types ?? []) u.append("type", t);
    if (filter.status) u.set("status", filter.status);
    if (filter.sourceName) u.set("source", filter.sourceName);
    if (filter.keyword) u.set("q", filter.keyword);
    if (one(sp.from)) u.set("from", one(sp.from));
    if (one(sp.to)) u.set("to", one(sp.to));
    if (filter.excluded) u.set("excluded", filter.excluded);
    u.set("page", String(p));
    return `?${u.toString()}`;
  };
  const input = "rounded border border-gray-300 px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">위협정보</h1>
      <form method="get" className="space-y-3 rounded border border-gray-200 p-3">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="font-medium">종류</span>
          {INDICATOR_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-1">
              <input type="checkbox" name="type" value={t} defaultChecked={filter.types?.includes(t)} />
              {TYPE_LABEL[t]}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            상태
            <select name="status" defaultValue={filter.status ?? ""} className={`${input} block`}>
              <option value="">전체</option>
              <option value="active">활성</option>
              <option value="inactive">비활성(만료)</option>
            </select>
          </label>
          <label className="text-sm">
            제공 기관
            <select name="source" defaultValue={filter.sourceName ?? ""} className={`${input} block max-w-56`}>
              <option value="">전체</option>
              {sourceNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            SIEM 제외
            <select name="excluded" defaultValue={filter.excluded ?? ""} className={`${input} block`}>
              <option value="">전체</option>
              <option value="only">제외된 것만</option>
              <option value="none">제외 안 된 것만</option>
            </select>
          </label>
          <label className="text-sm">
            키워드 (값·메모·기관명)
            <input name="q" defaultValue={filter.keyword ?? ""} maxLength={200} className={`${input} block`} />
          </label>
          <label className="text-sm">
            최종 확인일 시작
            <input name="from" type="date" defaultValue={one(sp.from)} className={`${input} block`} />
          </label>
          <label className="text-sm">
            종료
            <input name="to" type="date" defaultValue={one(sp.to)} className={`${input} block`} />
          </label>
          <button className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">검색</button>
          <Link href="/indicators" className="text-sm underline">
            초기화
          </Link>
        </div>
      </form>

      <p className="text-sm text-gray-600">총 {total.toLocaleString("ko-KR")}건</p>
      <div className="table-card">
        <table className="min-w-[1100px]">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="py-2 pr-3">종류</th>
              <th className="pr-3">값</th>
              <th className="pr-3">IP 주소</th>
              <th className="pr-3">국가</th>
              <th className="pr-3">국기</th>
              <th className="pr-3">제공 기관</th>
              <th className="pr-3">최초 확인</th>
              <th className="pr-3">최종 확인</th>
              <th>상태</th>
              <th>평판</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-100 align-top">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  {TYPE_LABEL[r.type]}
                  {r.hashKind && <span className="ml-1 text-xs text-gray-500">{r.hashKind}</span>}
                </td>
                <td className="min-w-[13rem] pr-3 break-all">
                  <Link href={`/indicators/${r.id}`} className="underline">
                    {r.value}
                  </Link>
                </td>
                <GeoCells g={geo.get(r.id)} />
                <td className="pr-3">{r.sourceNames.join(", ")}</td>
                <td className="pr-3 whitespace-nowrap">{fmt(r.firstSeenAt)}</td>
                <td className="pr-3 whitespace-nowrap">{fmt(r.lastSeenAt)}</td>
                <td className="whitespace-nowrap">
                  {r.status === "active" ? "활성" : <span className="text-gray-500">비활성</span>}
                  {r.excluded && <span className="ml-1 rounded bg-yellow-100 px-1 text-xs text-yellow-800">SIEM 제외</span>}
                </td>
                <td>{verdicts.has(r.id) ? <VerdictBadge verdict={verdicts.get(r.id)!} /> : <span className="text-[var(--ink-soft)]">-</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-6 text-center text-gray-500">
                  조건에 맞는 위협정보가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 text-sm">
        {page > 1 && <Link href={pageHref(page - 1)} className="underline">이전</Link>}
        <span>
          {page} / {pages}
        </span>
        {page < pages && <Link href={pageHref(page + 1)} className="underline">다음</Link>}
      </div>
    </div>
  );
}

const dash = <span className="text-[var(--ink-soft)]">-</span>;

/** IP 주소 · 국가 코드 · 국기 세 칸 */
function GeoCells({ g }: { g: GeoRow | undefined }) {
  if (!g || g.state === "none") return (<><td>{dash}</td><td>{dash}</td><td>{dash}</td></>);
  const note = g.state === "unresolved" ? "DNS에 없음" : g.state === "pending" ? "확인 대기" : null;
  return (
    <>
      <td className="font-mono text-[13px] whitespace-nowrap">{g.ip ?? <span className="font-sans text-xs text-[var(--ink-soft)]">{note}</span>}</td>
      <td className="whitespace-nowrap" title={countryName(g.countryCode) || g.netName || undefined}>
        {g.countryCode ? <b>{g.countryCode}</b> : g.ip ? <span className="text-xs text-[var(--ink-soft)]">{g.state === "pending" ? "확인 대기" : "알 수 없음"}</span> : dash}
      </td>
      <td>{g.countryCode ? <CountryFlag code={g.countryCode} /> : dash}</td>
    </>
  );
}
