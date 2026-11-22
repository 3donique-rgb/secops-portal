import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getIndicatorDetail } from "@/lib/indicator-query";
import { TYPE_LABEL } from "@/lib/labels";
import { requireUser } from "@/lib/session";

export const metadata = { title: "위협정보 상세 - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (d: Date) => d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

/** 외부 링크는 http(s)만 클릭 가능하게 한다 (javascript: 등 차단). */
const safeHref = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

export default async function IndicatorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const detail = await getIndicatorDetail(getDb(), id);
  if (!detail) notFound();
  const { indicator: i, sources } = detail;

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/indicators" className="text-sm underline">
        ← 목록
      </Link>
      <h1 className="text-xl font-bold break-all">{i.value}</h1>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
        <dt className="text-gray-500">종류</dt>
        <dd>
          {TYPE_LABEL[i.type]}
          {i.hashKind && ` (${i.hashKind})`}
        </dd>
        <dt className="text-gray-500">상태</dt>
        <dd>{i.status === "active" ? "활성" : "비활성 (90일 이상 재확인되지 않음)"}</dd>
        <dt className="text-gray-500">SIEM 제공</dt>
        <dd>{i.excluded ? "제외됨 (화이트리스트·자산·예약 주소와 일치) — 데이터는 보관 중" : "제공 대상"}</dd>
        <dt className="text-gray-500">최초 확인</dt>
        <dd>{fmt(i.firstSeenAt)}</dd>
        <dt className="text-gray-500">최종 확인</dt>
        <dd>{fmt(i.lastSeenAt)}</dd>
        {i.memo && (
          <>
            <dt className="text-gray-500">메모</dt>
            <dd>{i.memo}</dd>
          </>
        )}
      </dl>

      <section>
        <h2 className="mb-2 font-semibold">제공 기관 ({sources.length})</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="py-2 pr-3">기관</th>
              <th className="pr-3">최초 확인</th>
              <th className="pr-3">최종 확인</th>
              <th>원문</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const href = safeHref(s.refUrl);
              return (
                <tr key={s.sourceName} className="border-b border-gray-100 align-top">
                  <td className="py-1.5 pr-3 font-medium">{s.sourceName}</td>
                  <td className="pr-3 whitespace-nowrap">{fmt(s.firstSeenAt)}</td>
                  <td className="pr-3 whitespace-nowrap">{fmt(s.lastSeenAt)}</td>
                  <td className="break-all">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
                        {s.refUrl}
                      </a>
                    ) : (
                      (s.refUrl ?? "-")
                    )}
                    {s.note && <div className="text-gray-500">{s.note}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
