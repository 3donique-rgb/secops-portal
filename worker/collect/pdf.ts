import * as cheerio from "cheerio";
import { extractText, getDocumentProxy } from "unpdf";
import { MAX_SEEN, type PdfConfig } from "../../lib/source-config";
import { extractIndicators } from "./extract";
import { decodeText, type Fetcher } from "./fetcher";
import { seenOf } from "./html";
import type { CollectResult, SourceInfo } from "./types";

const PDF_URL = /\.pdf(?:$|[?#])/i;

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

/** 보고서 목록 페이지(또는 PDF 주소 하나)에서 새 PDF만 내려받아 본문에서 지표를 찾는다. */
export async function collectPdf(source: SourceInfo, fetcher: Fetcher): Promise<CollectResult> {
  const cfg = source.config as unknown as PdfConfig;
  let links: string[];
  let listBytes: Uint8Array | null = null;
  if (PDF_URL.test(source.url)) {
    links = [source.url];
  } else {
    const res = await fetcher(source.url);
    if (res.status >= 400) throw new Error(`목록 페이지를 열 수 없습니다 (HTTP ${res.status})`);
    if (/pdf/i.test(res.contentType)) {
      links = [source.url];
      listBytes = res.body;
    } else {
      const $ = cheerio.load(decodeText(res.body));
      links = [];
      $(cfg.linkSelector || "a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        try {
          const u = new URL(href, source.url);
          if (PDF_URL.test(u.pathname + u.search)) links.push(u.toString());
        } catch {
          /* 건너뜀 */
        }
      });
      links = [...new Set(links)];
      if (links.length === 0) throw new Error("목록 페이지에서 PDF 링크를 찾지 못했습니다. linkSelector를 확인하세요.");
    }
  }
  const seen = new Set(seenOf(source.config));
  const fresh = links.filter((l) => !seen.has(l)).slice(0, cfg.maxPdfs ?? 5);
  const items: CollectResult["items"] = [];
  const done: string[] = [];
  let failed = 0;
  for (const link of fresh) {
    try {
      let bytes = listBytes;
      if (!bytes) {
        const r = await fetcher(link);
        if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
        bytes = r.body;
      }
      const text = await pdfToText(bytes);
      for (const n of extractIndicators(text)) items.push({ raw: n.value, refUrl: link });
      done.push(link);
    } catch {
      failed++;
    }
  }
  if (fresh.length > 0 && failed === fresh.length) throw new Error(`새 PDF ${failed}건을 모두 읽지 못했습니다.`);
  return { items, seen: [...seen, ...done].slice(-MAX_SEEN) };
}
