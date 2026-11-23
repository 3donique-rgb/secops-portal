import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getNews } from "@/lib/news-query";
import { requireUser } from "@/lib/session";

export const metadata = { title: "보안뉴스 - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewsDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const a = UUID.test(id) ? await getNews(getDb(), id) : null;
  if (!a) notFound();
  const when = a.publishedAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/news" className="text-sm underline">← 보안뉴스 목록</Link>
      <h1 className="text-xl font-bold leading-snug">{a.title}</h1>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-[var(--ink-soft)]">
        <div className="flex gap-1.5"><dt>등록일시</dt><dd className="text-[var(--ink)]">{when}</dd></div>
        <div className="flex gap-1.5"><dt>언론사</dt><dd className="text-[var(--ink)]">{a.publisher || "-"}</dd></div>
        <div className="flex gap-1.5"><dt>수집 검색어</dt><dd className="text-[var(--ink)]">{a.keywords.join(", ") || "-"}</dd></div>
      </dl>
      <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <h2 className="mb-2 text-sm font-semibold">본문 (일부)</h2>
        {a.body ? <p className="whitespace-pre-line text-sm leading-7">{a.body}</p> : <p className="text-sm text-[var(--ink-soft)]">본문을 가져오지 못했습니다. 아래 원문 링크에서 확인하세요.</p>}
      </section>
      <p className="text-xs text-[var(--ink-soft)]">기사 전문이 아니라 일부만 저장합니다. 저작권은 각 언론사에 있습니다.</p>
      <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-block rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white">원문 보기</a>
    </div>
  );
}
