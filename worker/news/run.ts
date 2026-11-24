/** 보안뉴스 수집: 검색어별로 구글 뉴스 RSS(+네이버 검색 API)에서 기사를 모아 저장한다. */
import { sql } from "drizzle-orm";
import { newsArticles } from "../../db/schema";
import type { Db } from "../../lib/indicators";
import { NEWS_KEYWORDS, decodeGoogleNewsUrl, extractArticleText, isSafePublicUrl, parseGoogleRss, parseNaverNews, titleKey, type NewsItem } from "../../lib/news";

export type NewsOptions = {
  keywords?: readonly string[];
  /** 최근 며칠 기사를 찾을지 (겹쳐도 중복 저장되지 않는다) */
  days?: number;
  naver?: { id: string; secret: string };
  /** 본문을 가져올 기사 수 상한 (한 번 실행) */
  bodyLimit?: number;
  fetchImpl?: typeof fetch;
  safeUrl?: (u: string) => Promise<boolean>;
  now?: Date;
};
export type NewsResult = { found: number; inserted: number; bodies: number; errors: string[]; byProvider: Record<string, number> };

const UA = "Mozilla/5.0 (compatible; SecOpsPortalNewsBot/1.0)";

async function getText(f: typeof fetch, url: string, init: RequestInit = {}, max = 1_500_000): Promise<string> {
  const res = await f(url, { ...init, headers: { "user-agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, max);
}

export async function runNews(db: Db, opt: NewsOptions = {}): Promise<NewsResult> {
  const f = opt.fetchImpl ?? fetch;
  const keywords = opt.keywords ?? NEWS_KEYWORDS;
  const days = Math.min(Math.max(opt.days ?? 2, 1), 30);
  const safe = opt.safeUrl ?? ((u: string) => isSafePublicUrl(u));
  const res: NewsResult = { found: 0, inserted: 0, bodies: 0, errors: [], byProvider: {} };
  const byKey = new Map<string, { item: NewsItem; kws: Set<string> }>();
  const add = (item: NewsItem, kw: string) => {
    const k = titleKey(item.title);
    const cur = byKey.get(k);
    if (cur) {
      cur.kws.add(kw);
      if (cur.item.provider === "google" && item.provider === "naver" && item.summary) cur.item.summary ||= item.summary;
    } else byKey.set(k, { item, kws: new Set([kw]) });
  };

  for (const kw of keywords) {
    try {
      const q = encodeURIComponent(`${kw} when:${days}d`);
      const xml = await getText(f, `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`);
      for (const it of parseGoogleRss(xml)) add(it, kw);
    } catch (e) {
      res.errors.push(`구글 뉴스 "${kw}": ${e instanceof Error ? e.message : "오류"}`);
    }
    if (opt.naver) {
      try {
        const txt = await getText(f, `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(kw)}&display=100&sort=date`, {
          headers: { "X-Naver-Client-Id": opt.naver.id, "X-Naver-Client-Secret": opt.naver.secret },
        });
        const cutoff = (opt.now ?? new Date()).getTime() - days * 86_400_000;
        for (const it of parseNaverNews(JSON.parse(txt))) if (it.publishedAt.getTime() >= cutoff) add(it, kw);
      } catch (e) {
        res.errors.push(`네이버 "${kw}": ${e instanceof Error ? e.message : "오류"}`);
      }
    }
  }

  // 이미 저장된 기사는 건너뛰고(본문 가져오기 절약), 새 기사만 본문을 시도한다
  const keys = [...byKey.keys()];
  res.found = keys.length;
  const known = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const part = keys.slice(i, i + 500);
    const rows = await db.select({ k: newsArticles.titleKey }).from(newsArticles).where(sql`${newsArticles.titleKey} in ${part}`);
    for (const r of rows) known.add(r.k);
  }
  let bodyBudget = opt.bodyLimit ?? 200;
  for (const [k, { item, kws }] of byKey) {
    if (known.has(k)) continue;
    let body = item.summary;
    if (bodyBudget > 0) {
      const target = item.provider === "google" ? decodeGoogleNewsUrl(item.link) : item.link;
      if (target && (await safe(target))) {
        bodyBudget--;
        try {
          const text = extractArticleText(await getText(f, target, {}, 3_000_000));
          if (text.length > body.length) {
            body = text;
            res.bodies++;
          }
        } catch {
          /* 본문을 못 가져와도 제목·링크는 저장한다 */
        }
      }
    }
    const r = await db
      .insert(newsArticles)
      .values({ titleKey: k, title: item.title.slice(0, 500), publisher: item.publisher.slice(0, 100), publishedAt: item.publishedAt, body: body.slice(0, 30500), url: item.link, provider: item.provider, keywords: [...kws] })
      .onConflictDoNothing()
      .returning({ id: newsArticles.id });
    if (r.length) {
      res.inserted++;
      res.byProvider[item.provider] = (res.byProvider[item.provider] ?? 0) + 1;
    }
  }

  // 이전에 본문을 못 가져온 최근 기사(짧은 본문)는 다시 시도한다
  let retry = Math.min(bodyBudget, 60);
  if (retry > 0) {
    const weak = await db
      .select({ id: newsArticles.id, url: newsArticles.url, provider: newsArticles.provider, body: newsArticles.body })
      .from(newsArticles)
      .where(sql`length(${newsArticles.body}) < 400 and ${newsArticles.publishedAt} > now() - interval '7 days'`)
      .orderBy(sql`${newsArticles.publishedAt} desc`)
      .limit(retry * 2);
    for (const w of weak) {
      if (retry <= 0) break;
      const target = w.provider === "google" ? decodeGoogleNewsUrl(w.url) : w.url;
      if (!target || !(await safe(target))) continue;
      retry--;
      try {
        const text = extractArticleText(await getText(f, target, {}, 3_000_000));
        if (text.length > w.body.length + 50) {
          await db.update(newsArticles).set({ body: text.slice(0, 30500) }).where(sql`${newsArticles.id} = ${w.id}`);
          res.bodies++;
        }
      } catch {
        /* 다음 실행에서 다시 시도 */
      }
    }
  }
  return res;
}
