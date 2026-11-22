import * as cheerio from "cheerio";
import { MAX_SEEN, SEEN_KEY, type HtmlConfig } from "../../lib/source-config";
import { extractIndicators } from "./extract";
import { decodeText, type Fetcher } from "./fetcher";
import type { CollectResult, SourceInfo } from "./types";

const BLOCKS = "p,div,li,tr,td,th,h1,h2,h3,h4,h5,h6,section,article,pre,ul,ol,table,blockquote,dd,dt,header,footer";

/**
 * 영역의 글자만 꺼낸다. 칸·문단 사이에 줄바꿈을 넣어, 서로 다른 칸의 숫자가 붙어
 * 엉뚱한 IP로 읽히는 것(예: "…100.60" + "1.1.1.1")을 막는다.
 */
export function htmlToText($: cheerio.CheerioAPI, area: ReturnType<cheerio.CheerioAPI>): string {
  area.find("br").after("\n");
  area.find(BLOCKS).append("\n").prepend("\n");
  area.find("td, th").append(" | ");
  return area.text();
}

export const seenOf = (config: Record<string, unknown>): string[] => {
  const s = config[SEEN_KEY];
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
};

/** 게시판 목록 → 새 글만 열어 본문에서 지표를 찾는다. 글 하나가 실패해도 나머지는 계속한다. */
export async function collectHtml(source: SourceInfo, fetcher: Fetcher): Promise<CollectResult> {
  const cfg = source.config as unknown as HtmlConfig;
  const res = await fetcher(source.url);
  if (res.status >= 400) throw new Error(`목록 페이지를 열 수 없습니다 (HTTP ${res.status})`);
  const $ = cheerio.load(decodeText(res.body));
  const links: string[] = [];
  $(cfg.linkSelector).each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const u = new URL(href, source.url);
      if (u.protocol === "http:" || u.protocol === "https:") links.push(u.toString());
    } catch {
      /* 잘못된 링크는 건너뜀 */
    }
  });
  const unique = [...new Set(links)];
  if (unique.length === 0) throw new Error(`linkSelector(${cfg.linkSelector})로 글 링크를 찾지 못했습니다. 선택자를 확인하세요.`);

  const seen = new Set(seenOf(source.config));
  const fresh = unique.filter((l) => !seen.has(l)).slice(0, cfg.maxPosts ?? 20);
  const items: CollectResult["items"] = [];
  const done: string[] = [];
  let failed = 0;
  for (const link of fresh) {
    try {
      const r = await fetcher(link);
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      const $p = cheerio.load(decodeText(r.body));
      $p("script, style, noscript").remove();
      const area = cfg.contentSelector ? $p(cfg.contentSelector) : $p("body");
      const title = $p("title").first().text().trim().slice(0, 150);
      for (const n of extractIndicators(htmlToText($p, area))) items.push({ raw: n.value, refUrl: link, note: title || undefined });
      done.push(link); // 성공한 글만 "처리함"으로 기억 → 실패한 글은 다음 번에 다시 시도
    } catch {
      failed++;
    }
  }
  if (fresh.length > 0 && failed === fresh.length) throw new Error(`새 글 ${failed}건을 모두 열지 못했습니다.`);
  return { items, seen: [...seen, ...done].slice(-MAX_SEEN) };
}
