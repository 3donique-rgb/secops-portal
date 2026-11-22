/** 수집 출처 관리 (5.1, 5.7). API 키는 암호화해 저장하고 화면에는 "등록됨"만 보여 준다. */
import { desc, eq, sql } from "drizzle-orm";
import { collectRuns, sources } from "../db/schema";
import { encryptSecret } from "./crypto";
import type { Db } from "./indicators";
import { SEEN_KEY, validateSourceConfig, validateSourceUrl, type SourceKind } from "./source-config";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

export type SourceInput = {
  name: string;
  kind: string;
  url: string;
  /** JSON 문자열 */
  configText: string;
  /** 새 API 키. 비어 있으면 기존 값 유지 */
  apiKey?: string;
  clearApiKey?: boolean;
  enabled: boolean;
};

function check(input: SourceInput): Result<{ kind: SourceKind; config: Record<string, unknown>; name: string; url: string }> {
  const name = input.name.trim();
  if (!name || name.length > 100) return { ok: false, message: "기관명은 1~100자로 입력하세요. (모든 위협정보의 출처 표시에 쓰입니다)" };
  if (input.kind !== "api" && input.kind !== "html" && input.kind !== "pdf") return { ok: false, message: "수집 방식이 올바르지 않습니다." };
  const urlProblem = validateSourceUrl(input.url);
  if (urlProblem) return { ok: false, message: urlProblem };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.configText.trim() || "{}");
  } catch {
    return { ok: false, message: "설정이 올바른 JSON 형식이 아닙니다. 따옴표·쉼표·괄호를 확인하세요." };
  }
  const cfg = validateSourceConfig(input.kind, parsed);
  if (!cfg.ok) return { ok: false, message: cfg.message };
  if (input.apiKey && input.apiKey.length > 2000) return { ok: false, message: "API 키가 너무 깁니다." };
  return { ok: true, kind: input.kind, config: cfg.config, name, url: input.url.trim() };
}

export async function listSources(db: Db) {
  return db
    .select({
      id: sources.id,
      name: sources.name,
      kind: sources.kind,
      url: sources.url,
      enabled: sources.enabled,
      hasKey: sql<boolean>`${sources.apiKeyEnc} is not null`,
      lastSuccessAt: sources.lastSuccessAt,
      lastStatus: sql<string | null>`(select r.status from collect_runs r where r.source_id = "sources"."id" order by r.started_at desc limit 1)`,
      lastError: sql<string | null>`(select r.error_message from collect_runs r where r.source_id = "sources"."id" order by r.started_at desc limit 1)`,
    })
    .from(sources)
    .orderBy(sources.name);
}

export async function getSource(db: Db, id: string) {
  const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  if (!row) return null;
  const config = { ...row.config };
  delete config[SEEN_KEY]; // 수집기가 기억하는 값은 편집 화면에 보이지 않는다
  return { ...row, config, hasKey: row.apiKeyEnc !== null, apiKeyEnc: undefined };
}

export async function createSource(db: Db, input: SourceInput): Promise<Result<{ id: string }>> {
  const c = check(input);
  if (!c.ok) return c;
  const [dup] = await db.select({ id: sources.id }).from(sources).where(eq(sources.name, c.name)).limit(1);
  if (dup) return { ok: false, message: "같은 이름의 출처가 이미 있습니다." };
  const [row] = await db
    .insert(sources)
    .values({
      name: c.name, kind: c.kind, url: c.url, config: c.config, enabled: input.enabled,
      apiKeyEnc: input.apiKey ? encryptSecret(input.apiKey) : null,
    })
    .returning({ id: sources.id });
  return { ok: true, id: row.id };
}

export async function updateSource(db: Db, id: string, input: SourceInput): Promise<Result> {
  const c = check(input);
  if (!c.ok) return c;
  const [cur] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  if (!cur) return { ok: false, message: "출처를 찾을 수 없습니다." };
  const [dup] = await db.select({ id: sources.id }).from(sources).where(eq(sources.name, c.name)).limit(1);
  if (dup && dup.id !== id) return { ok: false, message: "같은 이름의 출처가 이미 있습니다." };
  // 주소·방식이 바뀌면 "이미 처리한 글" 기억은 의미가 없으므로 비운다
  const keepSeen = cur.url === c.url && cur.kind === c.kind && cur.config[SEEN_KEY] !== undefined;
  await db
    .update(sources)
    .set({
      name: c.name, kind: c.kind, url: c.url, enabled: input.enabled,
      config: keepSeen ? { ...c.config, [SEEN_KEY]: cur.config[SEEN_KEY] } : c.config,
      apiKeyEnc: input.apiKey ? encryptSecret(input.apiKey) : input.clearApiKey ? null : cur.apiKeyEnc,
    })
    .where(eq(sources.id, id));
  // 기관명을 바꿔도 이미 기록된 위협정보의 출처 이름(복사본)은 바꾸지 않는다: 수집 당시 기록 보존
  return { ok: true };
}

export async function setSourceEnabled(db: Db, id: string, enabled: boolean): Promise<Result> {
  const rows = await db.update(sources).set({ enabled }).where(eq(sources.id, id)).returning({ id: sources.id });
  return rows.length ? { ok: true } : { ok: false, message: "출처를 찾을 수 없습니다." };
}

export async function listRuns(db: Db, sourceId: string, limit = 100) {
  return db
    .select({ id: collectRuns.id, startedAt: collectRuns.startedAt, status: collectRuns.status, newCount: collectRuns.newCount, errorMessage: collectRuns.errorMessage })
    .from(collectRuns)
    .where(eq(collectRuns.sourceId, sourceId))
    .orderBy(desc(collectRuns.startedAt))
    .limit(limit);
}

/** 등록 화면에서 한 번에 채워 볼 수 있는 예시. 접속 가능 여부와 이용 조건은 등록하는 사람이 확인해야 한다. */
export const SOURCE_PRESETS = [
  { name: "abuse.ch Feodo Tracker (봇넷 C2 IP)", kind: "api", url: "https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.txt", config: { format: "text", mode: "lines" } },
  // URLhaus 는 현재 무료 계정의 Auth-Key 가 있어야 내려받을 수 있다(주소에 키가 들어가는 방식). 키를 받은 뒤 직접 등록한다.
] as const;
