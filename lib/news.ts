/**
 * 보안뉴스: 구글 뉴스 RSS와 네이버 검색 API 결과를 읽어 정리한다.
 * - 저장하는 것: 제목, 등록일시, 언론사, 본문 일부(최대 1,500자), 원문 주소. 기사 전문은 저장하지 않고 원문 링크로 연결한다.
 */
import { createHash } from "node:crypto";
import dns from "node:dns";
import { isReservedIp } from "./normalize";

export const NEWS_KEYWORDS = ["해킹", "사이버해킹", "사이버보안", "정보유출", "정보보안"] as const;
export const BODY_MAX = 1500;

export type NewsItem = { title: string; link: string; publishedAt: Date; publisher: string; summary: string; provider: "google" | "naver" };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const n = g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** HTML 태그를 없애고 공백을 정리한 글 */
export function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!m) return null;
  const v = m[1].trim();
  const c = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  return c ? c[1] : v;
};

/** 제목 끝의 " - 언론사"를 떼어 낸다 (구글 뉴스 형식) */
export function splitGoogleTitle(title: string, source: string | null): { title: string; publisher: string } {
  const t = title.trim();
  if (source && t.endsWith(` - ${source}`)) return { title: t.slice(0, -(source.length + 3)).trim(), publisher: source };
  const i = t.lastIndexOf(" - ");
  if (!source && i > 0) return { title: t.slice(0, i).trim(), publisher: t.slice(i + 3).trim() };
  return { title: t, publisher: source ?? "" };
}

/** 구글 뉴스 RSS 해석 */
export function parseGoogleRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    const rawTitle = tag(it, "title");
    const link = tag(it, "link");
    const pub = tag(it, "pubDate");
    if (!rawTitle || !link || !pub) continue;
    const when = new Date(pub);
    if (Number.isNaN(when.getTime())) continue;
    const source = tag(it, "source");
    const { title, publisher } = splitGoogleTitle(stripHtml(rawTitle), source ? stripHtml(source) : null);
    if (!title) continue;
    out.push({ title, link: decodeEntities(link.trim()), publishedAt: when, publisher, summary: "", provider: "google" });
  }
  return out;
}

/** 네이버 검색 API(뉴스) 응답 해석. 언론사 이름은 주지 않으므로 주소로 추정한다 */
export function parseNaverNews(json: unknown): NewsItem[] {
  const items = (json as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: NewsItem[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? stripHtml(r.title) : "";
    const link = String(r.originallink || r.link || "");
    const when = new Date(String(r.pubDate ?? ""));
    if (!title || !/^https?:\/\//i.test(link) || Number.isNaN(when.getTime())) continue;
    out.push({ title, link, publishedAt: when, publisher: publisherFromUrl(link), summary: typeof r.description === "string" ? stripHtml(r.description) : "", provider: "naver" });
  }
  return out;
}

const PUBLISHERS: Record<string, string> = {
  "boannews.com": "보안뉴스", "dailysecu.com": "데일리시큐", "etnews.com": "전자신문", "zdnet.co.kr": "지디넷코리아", "yna.co.kr": "연합뉴스", "chosun.com": "조선일보",
  "joongang.co.kr": "중앙일보", "donga.com": "동아일보", "hani.co.kr": "한겨레", "khan.co.kr": "경향신문", "mk.co.kr": "매일경제", "hankyung.com": "한국경제",
  "mt.co.kr": "머니투데이", "edaily.co.kr": "이데일리", "sedaily.com": "서울경제", "fnnews.com": "파이낸셜뉴스", "asiae.co.kr": "아시아경제", "newsis.com": "뉴시스",
  "news1.kr": "뉴스1", "ytn.co.kr": "YTN", "kbs.co.kr": "KBS", "mbc.co.kr": "MBC", "sbs.co.kr": "SBS", "jtbc.co.kr": "JTBC", "bloter.net": "블로터",
  "itworld.co.kr": "ITWorld", "ciokorea.com": "CIO Korea", "datanet.co.kr": "데이터넷", "inews24.com": "아이뉴스24", "ddaily.co.kr": "디지털데일리", "hankookilbo.com": "한국일보",
  "seoul.co.kr": "서울신문", "munhwa.com": "문화일보", "segye.com": "세계일보", "kmib.co.kr": "국민일보", "heraldcorp.com": "헤럴드경제", "nocutnews.co.kr": "노컷뉴스",
};
export function publisherFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  for (const [d, name] of Object.entries(PUBLISHERS)) if (host === d || host.endsWith(`.${d}`)) return name;
  return host;
}

/** 같은 기사 판단용 열쇠: 제목에서 글자·숫자만 남겨 해시 */
export function titleKey(title: string): string {
  const norm = title.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
  return createHash("sha256").update(norm).digest("hex");
}

/** 기사 HTML에서 본문 일부를 뽑는다: 본문 문단(<p>)을 우선, 없으면 메타 설명 */
export function extractArticleText(html: string, max = BODY_MAX): string {
  const scope = /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? html;
  const paras: string[] = [];
  for (const m of scope.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)) {
    const t = stripHtml(m[1]);
    if (t.length >= 40 && !/(저작권|무단\s*전재|구독|copyright|all rights reserved)/i.test(t)) paras.push(t);
    if (paras.join(" ").length > max) break;
  }
  let text = paras.join(" ");
  if (text.length < 80) {
    const og = /<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]*content=["']([^"']*)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']*)["'][^>]*(?:property=["']og:description["']|name=["']description["'])/i.exec(html);
    if (og) text = decodeEntities(og[1]).replace(/\s+/g, " ").trim();
  }
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** 구글 뉴스 링크(…/articles/CBMi…)에 들어 있는 원문 주소를 꺼내 본다. 안 되면 null */
export function decodeGoogleNewsUrl(link: string): string | null {
  const m = /\/rss\/articles\/([A-Za-z0-9_-]+)/.exec(link);
  if (!m) return null;
  try {
    const bin = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const u = /https?:\/\/[\x21-\x7e]+/.exec(bin)?.[0];
    return u ? u.replace(/[^\x21-\x7e].*$/, "") : null;
  } catch {
    return null;
  }
}

/** 외부에서 받은 주소로 서버가 접속하기 전 확인: http(s)이고 사설·예약 주소가 아니어야 한다 */
export async function isSafePublicUrl(url: string, lookup: (h: string) => Promise<string[]> = async (h) => (await dns.promises.lookup(h, { all: true })).map((a) => a.address)): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  try {
    const ips = await lookup(u.hostname);
    return ips.length > 0 && ips.every((ip) => !isReservedIp(ip));
  } catch {
    return false;
  }
}
