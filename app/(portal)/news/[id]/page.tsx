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
      <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
        {a.body ? (
          <div className="space-y-4 text-[15px] leading-8">
            {a.body.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--ink-soft)]">본문을 가져오지 못했습니다. 아래 원문 링크에서 확인하세요.</p>
        )}
      </section>
      <aside className="rounded-xl border border-[var(--line)] p-4 text-sm">
        <p className="font-semibold">출처</p>
        <p className="mt-1">
          {a.publisher || "언론사 미상"} · {when} 등록 ·{" "}
          <a href={a.url} target="_blank" rel="noopener noreferrer" className="break-all underline">
            원문 보기
          </a>
        </p>
        <p className="mt-2 text-xs text-[var(--ink-soft)]">기사 저작권은 해당 언론사에 있으며, 이 화면은 사내 보안관제 열람용입니다. 외부 공유·재배포하지 마세요. 본문 추출이 불완전할 수 있으니 중요한 내용은 원문으로 확인하세요.</p>
      </aside>
    </div>
  );
}
