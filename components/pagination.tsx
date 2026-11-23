import Link from "next/link";
import { PAGE_SIZES, pageAfterSizeChange, pageWindow, rangeLabel, totalPages } from "@/lib/pagination";

/**
 * 목록 아래쪽 이동 막대: 쪽 번호(10개씩), 이전·다음, 번호 입력 이동, 한 화면에 보이는 개수(10·50·100).
 * baseParams: 검색·필터 값(쪽·개수 제외). 이동할 때 그대로 유지한다.
 */
export function Pagination({ page, total, size, baseParams }: { page: number; total: number; size: number; baseParams: [string, string][] }) {
  const pages = totalPages(total, size);
  const cur = Math.min(page, pages);
  const href = (p: number, s = size) => {
    const u = new URLSearchParams();
    for (const [k, v] of baseParams) u.append(k, v);
    u.set("size", String(s));
    u.set("page", String(p));
    return `?${u.toString()}`;
  };
  const w = pageWindow(cur, pages);
  const { from, to } = rangeLabel(cur, size, total);
  const btn = "inline-flex h-9 min-w-9 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 text-sm hover:border-[var(--signal)]";
  const off = "inline-flex h-9 min-w-9 items-center justify-center rounded-lg border border-[var(--line)] px-2 text-sm text-[var(--ink-soft)] opacity-50";

  return (
    <nav aria-label="쪽 이동" className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[var(--ink-soft)]">
          {total.toLocaleString("ko-KR")}건 중 {from.toLocaleString("ko-KR")}–{to.toLocaleString("ko-KR")}번
        </p>
        <div className="flex items-center gap-1.5" role="group" aria-label="한 화면에 보이는 개수">
          <span className="mr-1 text-[var(--ink-soft)]">보기</span>
          {PAGE_SIZES.map((s) => (
            <Link
              key={s}
              href={href(pageAfterSizeChange(cur, size, s), s)}
              aria-current={s === size ? "true" : undefined}
              className={`${btn} aria-[current=true]:border-[var(--signal)] aria-[current=true]:bg-[var(--signal)] aria-[current=true]:font-semibold aria-[current=true]:!text-white`}
            >
              {s}개
            </Link>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap items-center gap-1.5">
          <li>
            {w.prevGroup ? (
              <Link href={href(w.prevGroup)} className={btn} aria-label="이전 10쪽">
                «
              </Link>
            ) : (
              <span className={off} aria-hidden="true">
                «
              </span>
            )}
          </li>
          <li>
            {cur > 1 ? (
              <Link href={href(cur - 1)} className={btn} aria-label="이전 쪽">
                ‹
              </Link>
            ) : (
              <span className={off} aria-hidden="true">
                ‹
              </span>
            )}
          </li>
          {w.numbers.map((n) => (
            <li key={n}>
              <Link
                href={href(n)}
                aria-current={n === cur ? "page" : undefined}
                className={`${btn} aria-[current=page]:border-[var(--signal)] aria-[current=page]:bg-[var(--signal)] aria-[current=page]:font-semibold aria-[current=page]:!text-white`}
              >
                {n}
              </Link>
            </li>
          ))}
          <li>
            {cur < pages ? (
              <Link href={href(cur + 1)} className={btn} aria-label="다음 쪽">
                ›
              </Link>
            ) : (
              <span className={off} aria-hidden="true">
                ›
              </span>
            )}
          </li>
          <li>
            {w.nextGroup ? (
              <Link href={href(w.nextGroup)} className={btn} aria-label="다음 10쪽">
                »
              </Link>
            ) : (
              <span className={off} aria-hidden="true">
                »
              </span>
            )}
          </li>
        </ul>

        <form method="get" className="plain-form flex items-center gap-2">
          {baseParams.map(([k, v], i) => (
            <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
          ))}
          <input type="hidden" name="size" value={size} />
          <label className="flex items-center gap-2 text-[var(--ink-soft)]">
            쪽 번호 입력
            <input name="page" type="number" inputMode="numeric" min={1} max={pages} defaultValue={cur} className="w-20" aria-label={`이동할 쪽 번호 (1~${pages})`} />
          </label>
          <span className="text-[var(--ink-soft)]">/ {pages.toLocaleString("ko-KR")}</span>
          <button type="submit" className={btn}>
            이동
          </button>
        </form>
      </div>
    </nav>
  );
}
