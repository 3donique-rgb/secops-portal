import Link from "next/link";
import { getDb } from "@/db";
import { Pagination } from "@/components/pagination";
import { searchNews } from "@/lib/news-query";
import { NEWS_KEYWORDS } from "@/lib/news";
import { parsePage, parsePageSize, totalPages } from "@/lib/pagination";
import { requireUser } from "@/lib/session";

export const metadata = { title: "보안뉴스 - 보안관제 포털" };

const DEFAULT_SIZE = 50;
const fmt = (d: Date) =>
  d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function NewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 100);
  const kw = (NEWS_KEYWORDS as readonly string[]).includes(one(sp.keyword)) ? one(sp.keyword) : "";
  const size = parsePageSize(sp.size, DEFAULT_SIZE);
  const db = getDb();
  const filter = { q: q || undefined, keyword: kw || undefined };
  const first = await searchNews(db, filter, { page: parsePage(sp.page), pageSize: size });
  const pages = totalPages(first.total, size);
  const page = Math.min(parsePage(sp.page), pages);
  const { rows, total } = page === parsePage(sp.page) ? first : await searchNews(db, filter, { page, pageSize: size });
  const baseParams: [string, string][] = [];
  if (q) baseParams.push(["q", q]);
  if (kw) baseParams.push(["keyword", kw]);
  const input = "rounded border border-gray-300 px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">보안뉴스</h1>
      <p className="text-sm text-[var(--ink-soft)]">해킹·사이버해킹·사이버보안·정보유출·정보보안 검색어로 매일 아침 구글 뉴스(와 네이버)에서 모은 기사입니다.</p>
      <form method="get" className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-3">
        <input type="hidden" name="size" value={size} />
        <label className="text-sm">
          수집 검색어
          <select name="keyword" defaultValue={kw} className={`${input} block`}>
            <option value="">전체</option>
            {NEWS_KEYWORDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          제목·언론사·본문 검색
          <input name="q" defaultValue={q} maxLength={100} className={`${input} block`} />
        </label>
        <button className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">검색</button>
        <Link href="/news" className="text-sm underline">초기화</Link>
      </form>

      <div className="table-card">
        <table className="min-w-[640px]">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="w-16 py-2 pr-3">연번</th>
              <th className="w-44 pr-3">등록일시</th>
              <th className="pr-3">제목</th>
              <th className="w-36">언론사</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-[var(--ink-soft)]">
                  {total === 0 && !q && !kw ? "아직 수집된 기사가 없습니다. 보안뉴스 수집 작업(GitHub Actions)이 실행되면 채워집니다." : "조건에 맞는 기사가 없습니다."}
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.id} className="border-b border-gray-100">
                <td className="py-2 pr-3 text-[var(--ink-soft)]">{(total - (page - 1) * size - i).toLocaleString("ko-KR")}</td>
                <td className="pr-3 whitespace-nowrap">{fmt(r.publishedAt)}</td>
                <td className="pr-3">
                  <Link href={`/news/${r.id}`} className="font-medium hover:underline">{r.title}</Link>
                </td>
                <td className="whitespace-nowrap">{r.publisher || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} size={size} baseParams={baseParams} />
    </div>
  );
}
