import { getDb } from "@/db";
import { describeFilter, parseIndicatorParams, type RawParams } from "@/lib/indicator-params";
import { INDICATOR_TYPES, countIndicators, listSourceNames } from "@/lib/indicator-query";
import { TYPE_LABEL } from "@/lib/labels";
import { REPORT_MAX_ROWS } from "@/lib/report-pdf";
import { requireUser } from "@/lib/session";

export const metadata = { title: "보고서 - 보안관제 포털" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requireUser();
  const sp = await searchParams;
  const { filter } = parseIndicatorParams(sp);
  const searched = Object.keys(sp).length > 0;
  const db = getDb();
  const [sourceNames, count] = await Promise.all([
    listSourceNames(db),
    searched ? countIndicators(db, filter) : Promise.resolve(null),
  ]);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const input = "rounded border border-gray-300 px-2 py-1.5 text-sm";
  const pdfHref = (() => {
    const u = new URLSearchParams();
    for (const t of filter.types ?? []) u.append("type", t);
    if (filter.status) u.set("status", filter.status);
    if (filter.sourceName) u.set("source", filter.sourceName);
    if (filter.keyword) u.set("q", filter.keyword);
    if (one(sp.from)) u.set("from", one(sp.from));
    if (one(sp.to)) u.set("to", one(sp.to));
    if (filter.excluded) u.set("excluded", filter.excluded);
    return `/reports/pdf?${u.toString()}`;
  })();

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-xl font-bold">PDF 보고서</h1>
      <p className="text-sm text-gray-600">
        조건을 입력하고 “건수 확인”을 누른 뒤 PDF를 내려받습니다. 한 번에 최대 {REPORT_MAX_ROWS.toLocaleString("ko-KR")}건까지 수록합니다.
      </p>
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
            최종 확인일 시작
            <input name="from" type="date" defaultValue={one(sp.from)} className={`${input} block`} />
          </label>
          <label className="text-sm">
            종료
            <input name="to" type="date" defaultValue={one(sp.to)} className={`${input} block`} />
          </label>
          <label className="text-sm">
            키워드 (값·메모·기관명)
            <input name="q" defaultValue={filter.keyword ?? ""} maxLength={200} className={`${input} block`} />
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
            상태
            <select name="status" defaultValue={filter.status ?? ""} className={`${input} block`}>
              <option value="">전체</option>
              <option value="active">활성</option>
              <option value="inactive">비활성(만료)</option>
            </select>
          </label>
          <button className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">건수 확인</button>
        </div>
      </form>

      {count !== null && (
        <div className="space-y-2 rounded bg-gray-50 p-3 text-sm">
          <p>
            조건: {describeFilter(sp, filter).join(" / ") || "없음 (전체)"}
          </p>
          <p className="font-medium">
            조건에 맞는 위협정보 {count.toLocaleString("ko-KR")}건
            {count > REPORT_MAX_ROWS && <span className="ml-2 font-normal text-red-700">(최근 확인된 {REPORT_MAX_ROWS.toLocaleString("ko-KR")}건만 수록됩니다. 조건을 좁혀 주세요)</span>}
          </p>
          <a href={pdfHref} className="inline-block rounded bg-gray-900 px-3 py-1.5 text-white">
            PDF 내려받기
          </a>
        </div>
      )}
    </div>
  );
}
