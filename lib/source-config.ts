/** 수집 출처별 설정(JSON)의 형식과 검사. 화면(5.1)과 수집기(5.3~5.5)가 같은 규칙을 쓴다. */
export type ApiConfig = {
  format: "json" | "text" | "csv";
  method?: "GET" | "POST";
  /** POST일 때 보낼 JSON 본문 */
  body?: Record<string, unknown>;
  /** json: 목록이 있는 위치. 예: "data.items" (생략하면 응답 자체가 목록) */
  itemsPath?: string;
  /** json: 각 항목에서 값을 꺼낼 필드 이름들. 예: ["ioc", "url"] (항목이 문자열이면 생략) */
  valueFields?: string[];
  /** csv: 값이 있는 열 번호(0부터) */
  columns?: number[];
  /** csv: 건너뛸 첫 줄 수 (머리글) */
  skipLines?: number;
  /** text: lines(한 줄에 값 하나, 기본) | free(문장 속에서 값을 찾아냄) */
  mode?: "lines" | "free";
  /** API 키를 넣을 헤더 이름 (기본 Authorization) 과 앞에 붙일 말 (기본 "Bearer ") */
  authHeader?: string;
  authPrefix?: string;
  /** 헤더 대신 주소의 질의 값으로 키를 보낼 때 그 이름 */
  apiKeyParam?: string;
};
export type HtmlConfig = {
  /** 게시글 목록에서 글 링크를 고르는 CSS 선택자 */
  linkSelector: string;
  /** 글 본문 영역 CSS 선택자 (생략하면 페이지 전체) */
  contentSelector?: string;
  maxPosts?: number;
};
export type PdfConfig = {
  /** 목록 페이지에서 PDF 링크를 고르는 CSS 선택자 (기본 a[href]) */
  linkSelector?: string;
  maxPdfs?: number;
};

export type SourceKind = "api" | "html" | "pdf";
export type SourceConfigMap = { api: ApiConfig; html: HtmlConfig; pdf: PdfConfig };

/** 수집기가 "이미 처리한 글/파일"을 기억하는 곳. 화면에서 편집하는 JSON에는 보이지 않는다. */
export const SEEN_KEY = "_seen";
export const MAX_SEEN = 1000;

export const CONFIG_TEMPLATES: Record<SourceKind, string> = {
  api: JSON.stringify({ format: "text", mode: "lines" }, null, 2),
  html: JSON.stringify({ linkSelector: "a.post-link", contentSelector: ".post-content", maxPosts: 20 }, null, 2),
  pdf: JSON.stringify({ linkSelector: "a[href]", maxPdfs: 5 }, null, 2),
};

const isStr = (v: unknown): v is string => typeof v === "string";
const strArr = (v: unknown) => Array.isArray(v) && v.every(isStr);
const intArr = (v: unknown) => Array.isArray(v) && v.every((n) => Number.isInteger(n) && (n as number) >= 0);

/** 설정을 검사한다. 맞으면 정리된 설정(_seen 제외)을, 틀리면 오류 문구를 돌려준다. */
export function validateSourceConfig(
  kind: SourceKind,
  raw: unknown,
): { ok: true; config: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, message: "설정은 { } 형태의 JSON이어야 합니다." };
  const c = { ...(raw as Record<string, unknown>) };
  delete c[SEEN_KEY];
  const bad = (m: string) => ({ ok: false as const, message: m });
  if (kind === "api") {
    if (!["json", "text", "csv"].includes(c.format as string)) return bad('format 은 "json", "text", "csv" 중 하나여야 합니다.');
    if (c.method !== undefined && c.method !== "GET" && c.method !== "POST") return bad('method 는 "GET" 또는 "POST" 입니다.');
    if (c.body !== undefined && (typeof c.body !== "object" || c.body === null || Array.isArray(c.body))) return bad("body 는 { } 형태여야 합니다.");
    if (c.itemsPath !== undefined && !isStr(c.itemsPath)) return bad("itemsPath 는 문자열입니다.");
    if (c.valueFields !== undefined && !strArr(c.valueFields)) return bad("valueFields 는 문자열 목록입니다. 예: [\"ioc\"]");
    if (c.columns !== undefined && !intArr(c.columns)) return bad("columns 는 0 이상의 숫자 목록입니다. 예: [0]");
    if (c.skipLines !== undefined && !(Number.isInteger(c.skipLines) && (c.skipLines as number) >= 0)) return bad("skipLines 는 0 이상의 정수입니다.");
    if (c.mode !== undefined && c.mode !== "lines" && c.mode !== "free") return bad('mode 는 "lines" 또는 "free" 입니다.');
    for (const k of ["authHeader", "authPrefix", "apiKeyParam"]) if (c[k] !== undefined && !isStr(c[k])) return bad(`${k} 는 문자열입니다.`);
    if (c.format === "csv" && c.columns === undefined) return bad("csv 는 값이 있는 열 번호 columns 가 필요합니다. 예: [0]");
  } else if (kind === "html") {
    if (!isStr(c.linkSelector) || !c.linkSelector.trim()) return bad("linkSelector(글 링크 선택자)가 필요합니다.");
    if (c.contentSelector !== undefined && !isStr(c.contentSelector)) return bad("contentSelector 는 문자열입니다.");
    if (c.maxPosts !== undefined && !(Number.isInteger(c.maxPosts) && (c.maxPosts as number) >= 1 && (c.maxPosts as number) <= 200)) return bad("maxPosts 는 1~200 사이 정수입니다.");
  } else {
    if (c.linkSelector !== undefined && !isStr(c.linkSelector)) return bad("linkSelector 는 문자열입니다.");
    if (c.maxPdfs !== undefined && !(Number.isInteger(c.maxPdfs) && (c.maxPdfs as number) >= 1 && (c.maxPdfs as number) <= 50)) return bad("maxPdfs 는 1~50 사이 정수입니다.");
  }
  return { ok: true, config: c };
}

/** 출처 주소는 http(s)만 허용한다. */
export function validateSourceUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "주소는 http:// 또는 https:// 로 시작해야 합니다.";
    if (u.username || u.password) return "주소에 아이디·비밀번호를 넣지 마세요. API 키 칸을 사용하세요.";
    return null;
  } catch {
    return "올바른 주소가 아닙니다.";
  }
}
