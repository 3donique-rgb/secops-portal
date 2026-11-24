import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newsArticles } from "../db/schema";
import { decodeGoogleNewsUrl, extractArticleText, isSafePublicUrl, parseGoogleRss, parseNaverNews, publisherFromUrl, splitGoogleTitle, stripHtml, titleKey } from "../lib/news";
import { getNews, latestNews, searchNews } from "../lib/news-query";
import { runNews } from "../worker/news/run";
import { createTestDb, resetData } from "./helpers/test-db";

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>KT 해킹 사고 &amp; 정보유출 확인 - 보안뉴스</title><link>https://news.google.com/rss/articles/CBMiabc?oc=5</link><pubDate>Mon, 23 Nov 2026 21:30:00 GMT</pubDate><description>&lt;a&gt;x&lt;/a&gt;</description><source url="https://www.boannews.com">보안뉴스</source></item>
<item><title><![CDATA[랜섬웨어 급증 - 연합뉴스]]></title><link>https://news.google.com/rss/articles/CBMiabd</link><pubDate>Mon, 23 Nov 2026 20:00:00 GMT</pubDate></item>
<item><title>날짜 없음</title><link>https://x.test</link></item>
</channel></rss>`;

describe("뉴스 해석", () => {
  it("구글 RSS", () => {
    const r = parseGoogleRss(RSS);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: "KT 해킹 사고 & 정보유출 확인", publisher: "보안뉴스", provider: "google" });
    expect(r[0].publishedAt.toISOString()).toBe("2026-11-23T21:30:00.000Z");
    expect(r[1]).toMatchObject({ title: "랜섬웨어 급증", publisher: "연합뉴스" });
  });
  it("제목 분리·태그 제거·엔티티", () => {
    expect(splitGoogleTitle("가 - 나 - 매일경제", null)).toEqual({ title: "가 - 나", publisher: "매일경제" });
    expect(stripHtml("<b>해킹</b> &quot;사고&quot; &#39;끝&#39;")).toBe("해킹 \"사고\" '끝'");
  });
  it("네이버 JSON", () => {
    const r = parseNaverNews({ items: [{ title: "<b>해킹</b> 사건", originallink: "https://www.boannews.com/a?1", link: "https://n.news.naver.com/x", description: "요약 &amp; 내용", pubDate: "Mon, 23 Nov 2026 09:00:00 +0900" }, { title: "", link: "x" }] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ title: "해킹 사건", publisher: "보안뉴스", summary: "요약 & 내용", provider: "naver" });
    expect(publisherFromUrl("https://unknown.example.org/a")).toBe("unknown.example.org");
  });
  it("같은 제목은 같은 열쇠", () => {
    expect(titleKey("KT, 해킹!")).toBe(titleKey("kt 해킹"));
    expect(titleKey("a")).not.toBe(titleKey("b"));
  });
  it("본문 추출: 문단 유지, 군더더기 제거", () => {
    const html = `<html><body><nav><p>메뉴</p></nav><div id="articleBody"><p>첫 문단입니다. ${"해킹 피해가 확인되었다. ".repeat(6)}</p><p>둘째 문단입니다. ${"사고 경위가 설명된다. ".repeat(6)}</p><p>무단 전재 및 재배포 금지</p></div><script>var a=1</script></body></html>`;
    const t = extractArticleText(html);
    expect(t.startsWith("첫 문단입니다.")).toBe(true);
    expect(t.split("\n\n")).toHaveLength(2);
    expect(t).not.toContain("무단");
    expect(t).not.toContain("메뉴");
    const br = `<div class="article-body">${"가나다라마바사 ".repeat(30)}<br><br>${"아자차카타파하 ".repeat(30)}</div>`;
    expect(extractArticleText(br).split("\n\n")).toHaveLength(2);
    expect(extractArticleText(`<meta property="og:description" content="메타 설명 &amp; 요약">`)).toBe("메타 설명 & 요약");
    expect(extractArticleText(`<article>${"<p>" + "가".repeat(100) + "</p>"}</article>`.repeat(5), 200).length).toBeLessThanOrEqual(201);
  });
  it("구글 링크 해독·주소 안전 확인", async () => {
    const id = Buffer.from("\x08\x13\x22\x1ahttps://www.boannews.com/media/view.asp?idx=1\x92\x01").toString("base64url");
    expect(decodeGoogleNewsUrl(`https://news.google.com/rss/articles/${id}?oc=5`)).toBe("https://www.boannews.com/media/view.asp?idx=1");
    expect(decodeGoogleNewsUrl("https://news.google.com/rss/articles/CBMi")).toBeNull();
    expect(await isSafePublicUrl("http://127.0.0.1/x", async () => ["127.0.0.1"])).toBe(false);
    expect(await isSafePublicUrl("file:///etc/passwd")).toBe(false);
    expect(await isSafePublicUrl("https://a.test/x", async () => ["93.184.216.34"])).toBe(true);
    expect(await isSafePublicUrl("https://a.test/x", async () => ["93.184.216.34", "10.0.0.1"])).toBe(false);
  });
});

describe("수집·조회", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await ctx.client.close();
  });
  beforeEach(async () => {
    await resetData(ctx.client);
  });

  const art = `<html><article><p>${"본문 문장입니다. 사고 경위가 자세히 설명된다. ".repeat(5)}</p></article></html>`;
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("news.google.com/rss/search")) return new Response(RSS, { status: 200 });
    if (u.includes("openapi.naver.com")) return new Response(JSON.stringify({ items: [{ title: "랜섬웨어 급증", originallink: "https://www.yna.co.kr/v/1", description: "네이버 요약", pubDate: "Mon, 23 Nov 2026 20:00:00 GMT" }, { title: "새 기사 정보보안", originallink: "https://www.etnews.com/2", description: "요약2", pubDate: "Mon, 23 Nov 2026 22:00:00 GMT" }] }), { status: 200 });
    if (u.includes("boannews") || u.includes("etnews")) return new Response(art, { status: 200 });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const base = { keywords: ["해킹", "정보보안"], fetchImpl, safeUrl: async () => true, now: new Date("2026-11-24T00:00:00Z"), days: 2 };

  it("저장·중복 제거·재실행", async () => {
    const r1 = await runNews(ctx.db, { ...base, naver: { id: "i", secret: "s" } });
    expect(r1.errors).toEqual([]);
    expect(r1.inserted).toBe(3); // KT, 랜섬웨어(구글·네이버 중복 1건), 새 기사
    const all = await ctx.db.select().from(newsArticles);
    expect(all.find((a) => a.title.startsWith("새 기사"))?.body).toContain("본문 문장입니다");
    expect(all.find((a) => a.title === "랜섬웨어 급증")?.keywords.sort()).toEqual(["정보보안", "해킹"]);
    const r2 = await runNews(ctx.db, { ...base, naver: { id: "i", secret: "s" } });
    expect(r2.inserted).toBe(0);
    expect(await ctx.db.select().from(newsArticles)).toHaveLength(3);
  });
  it("검색 실패는 오류 목록에 남기고 계속", async () => {
    const bad = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
    const r = await runNews(ctx.db, { ...base, fetchImpl: bad });
    expect(r.inserted).toBe(0);
    expect(r.errors).toHaveLength(2);
  });
  it("목록: 최신순·쪽 나누기·검색", async () => {
    await runNews(ctx.db, { ...base, naver: { id: "i", secret: "s" } });
    const p1 = await searchNews(ctx.db, {}, { page: 1, pageSize: 2 });
    expect(p1.total).toBe(3);
    expect(p1.rows.map((r) => r.title)).toEqual(["새 기사 정보보안", "KT 해킹 사고 & 정보유출 확인"]);
    expect((await searchNews(ctx.db, {}, { page: 2, pageSize: 2 })).rows).toHaveLength(1);
    expect((await searchNews(ctx.db, { q: "랜섬" }, { page: 1, pageSize: 10 })).total).toBe(1);
    expect((await searchNews(ctx.db, { keyword: "정보보안" }, { page: 1, pageSize: 10 })).total).toBeGreaterThan(0);
    expect((await searchNews(ctx.db, { q: "100%_" }, { page: 1, pageSize: 10 })).total).toBe(0);
    expect((await getNews(ctx.db, p1.rows[0].id))?.url).toContain("etnews");
    expect((await latestNews(ctx.db, 2)).map((r) => r.title)).toEqual(["새 기사 정보보안", "KT 해킹 사고 & 정보유출 확인"]);
  });
});
