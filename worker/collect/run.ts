/**
 * 수집 실행 틀 (5.2): 사용 중인 출처를 차례로 돌며 수집 → 저장 → 이력 기록.
 * 출처 하나가 실패해도 나머지는 계속한다. 실패 사유는 collect_runs 에 남기되 API 키 값은 지운다.
 */
import { eq } from "drizzle-orm";
import { collectRuns, sources } from "../../db/schema";
import { decryptSecret } from "../../lib/crypto";
import type { Db } from "../../lib/indicators";
import { saveIndicator } from "../../lib/indicators";
import { SEEN_KEY, validateSourceConfig, validateSourceUrl } from "../../lib/source-config";
import { recomputeExcluded } from "../../lib/whitelist";
import { collectApi } from "./api";
import type { Fetcher } from "./fetcher";
import { collectHtml } from "./html";
import { collectPdf } from "./pdf";
import type { CollectResult, SourceInfo } from "./types";

export type RunResult = {
  sourceId: string;
  name: string;
  status: "success" | "fail";
  /** 새로 만들어진 지표 수 */
  newCount: number;
  /** 이번에 찾은 값(중복 포함) 수 */
  found: number;
  error?: string;
};

export type RunOptions = {
  fetcher: Fetcher;
  now?: () => Date;
  encKey?: string;
  onlySourceId?: string;
};

export async function collectSource(source: SourceInfo, apiKey: string | null, fetcher: Fetcher): Promise<CollectResult> {
  switch (source.kind) {
    case "api":
      return collectApi(source, apiKey, fetcher);
    case "html":
      return collectHtml(source, fetcher);
    case "pdf":
      return collectPdf(source, fetcher);
  }
}

const scrub = (msg: string, secret: string | null) => {
  let m = secret ? msg.split(secret).join("***") : msg;
  m = m.replace(/(api[_-]?key|token|authorization)=([^&\s]+)/gi, "$1=***");
  return m.slice(0, 500);
};

export async function runCollect(db: Db, opts: RunOptions): Promise<RunResult[]> {
  const now = opts.now ?? (() => new Date());
  const rows = await db.select().from(sources).where(eq(sources.enabled, true)).orderBy(sources.name);
  const results: RunResult[] = [];
  let anySaved = false;

  for (const row of rows) {
    if (opts.onlySourceId && row.id !== opts.onlySourceId) continue;
    const startedAt = now();
    let apiKey: string | null = null;
    try {
      const urlProblem = validateSourceUrl(row.url);
      if (urlProblem) throw new Error(urlProblem);
      const cfg = validateSourceConfig(row.kind, row.config);
      if (!cfg.ok) throw new Error(`설정 오류: ${cfg.message}`);
      if (row.apiKeyEnc) apiKey = decryptSecret(row.apiKeyEnc, opts.encKey);

      const info: SourceInfo = {
        id: row.id,
        name: row.name,
        kind: row.kind,
        url: row.url,
        // 수집기가 기억해 둔 "처리한 글 목록"은 설정 검사에서는 빠지므로 다시 붙여 준다
        config: { ...cfg.config, ...(row.config[SEEN_KEY] ? { [SEEN_KEY]: row.config[SEEN_KEY] } : {}) },
      };
      const result = await collectSource(info, apiKey, opts.fetcher);

      let created = 0;
      for (const item of result.items) {
        const r = await saveIndicator(db, {
          raw: item.raw,
          source: { id: row.id, name: row.name },
          refUrl: item.refUrl,
          note: item.note,
          now: startedAt,
        });
        if (r.status === "created") created++;
        if (r.status !== "invalid") anySaved = true;
      }
      await db.insert(collectRuns).values({ sourceId: row.id, startedAt, status: "success", newCount: created });
      await db
        .update(sources)
        .set({
          lastSuccessAt: startedAt,
          ...(result.seen ? { config: { ...cfg.config, [SEEN_KEY]: result.seen } } : {}),
        })
        .where(eq(sources.id, row.id));
      results.push({ sourceId: row.id, name: row.name, status: "success", newCount: created, found: result.items.length });
    } catch (e) {
      const message = scrub(e instanceof Error ? e.message : String(e), apiKey);
      try {
        await db.insert(collectRuns).values({ sourceId: row.id, startedAt, status: "fail", newCount: 0, errorMessage: message });
      } catch {
        /* 이력 기록 실패가 다른 출처 수집을 막지 않도록 한다 */
      }
      results.push({ sourceId: row.id, name: row.name, status: "fail", newCount: 0, found: 0, error: message });
    }
  }
  if (anySaved) await recomputeExcluded(db);
  return results;
}
