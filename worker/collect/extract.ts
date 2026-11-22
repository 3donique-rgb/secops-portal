/** 글·PDF 본문에서 위협정보 후보(IP, 도메인, URL, 해시, 메일 주소)를 찾아낸다. 최종 판정은 normalize()가 한다. */
import { normalize, type NormalizedIndicator } from "../../lib/normalize";

/** 본문 전체에서 방어 표기(defang)를 되돌린다. normalize 의 refang 은 값 한 개 앞부분만 다룬다. */
export function refangText(text: string): string {
  return text
    .replace(/\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\}/gi, ".")
    .replace(/\[\s*(?:@|at)\s*\]|\(\s*(?:@|at)\s*\)|\{\s*(?:@|at)\s*\}/gi, "@")
    .replace(/\[\s*:\s*\]/g, ":")
    .replace(/\bhxxp(s?)(?=:\/\/|\[:\]\/\/)/gi, "http$1")
    .replace(/\bfxp(s?)(?=:\/\/)/gi, "ftp$1");
}

// 파일 이름 확장자와 헷갈리는 "도메인"은 거른다 (report.pdf, image.png 등)
const NOT_TLD = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "json", "xml", "html", "htm", "php", "asp", "aspx", "jsp",
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico", "zip", "rar", "gz", "tar", "7z", "log", "md", "py", "js", "css", "dll", "sys", "bat", "ps1", "lnk", "iso", "tmp", "dat", "bin", "cfg", "ini", "yml", "yaml",
]);

const URL_RE = /\b(?:https?|ftp):\/\/[^\s<>"'`]+/gi;
const EMAIL_RE = /(?<![\w.%+-])[a-z0-9._%+'-]{1,64}@(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/gi;
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)/g;
const IPV6_RE = /(?<![\w:])(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}(?![\w:])/gi;
const HASH_RE = /(?<![a-f0-9])(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})(?![a-f0-9])/gi;
const DOMAIN_RE = /(?<![\w@.-])(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{1,62}(?![\w-])/gi;

export const MAX_CANDIDATES = 50_000;

/** URL 끝에 붙은 문장부호(마침표, 닫는 괄호 등)를 떼어 낸다. */
function trimUrl(u: string): string {
  return u.replace(/[.,;:!?)\]}>'"]+$/, "");
}

export function extractCandidates(text: string): string[] {
  const t = refangText(text);
  const out = new Set<string>();
  const add = (s: string) => {
    if (out.size < MAX_CANDIDATES) out.add(s);
  };
  let rest = t;
  for (const m of t.matchAll(URL_RE)) add(trimUrl(m[0]));
  rest = rest.replace(URL_RE, " ");
  for (const m of rest.matchAll(EMAIL_RE)) add(m[0]);
  rest = rest.replace(EMAIL_RE, " ");
  for (const m of rest.matchAll(HASH_RE)) add(m[0]);
  rest = rest.replace(HASH_RE, " ");
  for (const m of rest.matchAll(IPV6_RE)) add(m[0]);
  rest = rest.replace(IPV6_RE, " ");
  for (const m of rest.matchAll(IPV4_RE)) add(m[0]);
  rest = rest.replace(IPV4_RE, " ");
  for (const m of rest.matchAll(DOMAIN_RE)) {
    const tld = m[0].slice(m[0].lastIndexOf(".") + 1).toLowerCase();
    if (!NOT_TLD.has(tld)) add(m[0]);
  }
  return [...out];
}

/** 후보 중 정규화에 성공한 것만, 정규화된 값 기준으로 중복 없이 돌려준다. */
export function extractIndicators(text: string): NormalizedIndicator[] {
  const seen = new Set<string>();
  const result: NormalizedIndicator[] = [];
  for (const c of extractCandidates(text)) {
    const n = normalize(c);
    if (!n) continue;
    const key = `${n.type}|${n.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(n);
  }
  return result;
}
