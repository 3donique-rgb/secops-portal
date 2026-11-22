/** 외부 요청: 제한 시간 30초, 실패 시 2회 재시도, 응답 크기 상한. 수집기는 이 함수의 "모양"만 알면 되므로 시험 때 가짜로 바꿔 끼운다. */
export type FetchInit = { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string };
export type FetchResult = { status: number; contentType: string; body: Uint8Array };
export type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResult>;

export const FETCH_TIMEOUT_MS = 30_000;
export const FETCH_RETRIES = 2;
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeFetcher(opts: { timeoutMs?: number; retries?: number; fetchImpl?: typeof fetch } = {}): Fetcher {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const retries = opts.retries ?? FETCH_RETRIES;
  const doFetch = opts.fetchImpl ?? fetch;
  return async (url, init = {}) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(url, {
          method: init.method ?? "GET",
          headers: { "User-Agent": "SecOpsPortal-Collector/1.0", Accept: "*/*", ...init.headers },
          body: init.body,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });
        // 서버 오류(5xx)·요청 과다(429)는 재시도, 그 밖의 응답은 그대로 돌려준다 (4xx는 설정 문제이므로 재시도해도 소용없음)
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const len = Number(res.headers.get("content-length") ?? "0");
        if (len > MAX_BODY_BYTES) throw new Error(`응답이 너무 큽니다 (${Math.round(len / 1048576)}MB, 상한 25MB)`);
        const body = new Uint8Array(await res.arrayBuffer());
        if (body.length > MAX_BODY_BYTES) throw new Error("응답이 너무 큽니다 (상한 25MB)");
        return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
      } catch (e) {
        lastError = e;
        if (e instanceof Error && e.message.startsWith("응답이 너무")) throw e;
        if (attempt < retries) await sleep(500 * 2 ** attempt);
      }
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`요청 실패 (${retries + 1}회 시도): ${msg}`);
  };
}

export const decodeText = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b);
