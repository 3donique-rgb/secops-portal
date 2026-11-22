/** SIEM 연동용 API 키. 원문은 발급 때 한 번만 보여 주고, 저장은 SHA-256 해시만 한다 [고정]. */
import { createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { apiKeys } from "../db/schema";
import type { Db } from "./indicators";

export const API_KEY_PREFIX = "sopk_";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

export async function createApiKey(
  db: Db,
  input: { name: string; createdBy?: string | null },
): Promise<{ ok: true; id: string; key: string } | { ok: false; message: string }> {
  const name = input.name.trim();
  if (!name || name.length > 100) return { ok: false, message: "이름은 1~100자로 입력하세요. (예: 운영 SIEM)" };
  const key = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ name, keyHash: hashApiKey(key), createdBy: input.createdBy ?? null })
    .returning({ id: apiKeys.id });
  return { ok: true, id: row.id, key };
}

export async function listApiKeys(db: Db) {
  return db
    .select({ id: apiKeys.id, name: apiKeys.name, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revoked: apiKeys.revoked })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(db: Db, id: string): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const rows = await db.update(apiKeys).set({ revoked: true }).where(eq(apiKeys.id, id)).returning({ name: apiKeys.name });
  if (rows.length === 0) return { ok: false, message: "키를 찾을 수 없습니다." };
  return { ok: true, name: rows[0].name };
}

/** "Authorization: Bearer <키>" 헤더로 키를 확인한다. 없거나 틀리거나 폐기됐으면 null. */
export async function authenticateApiKey(
  db: Db,
  authorization: string | null,
  now: Date = new Date(),
): Promise<{ id: string; name: string } | null> {
  const m = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!m || m[1].length > 200) return null;
  const [row] = await db
    .select({ id: apiKeys.id, name: apiKeys.name, revoked: apiKeys.revoked, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(m[1])))
    .limit(1);
  if (!row || row.revoked) return null;
  // 호출마다 쓰기를 피하려고 마지막 사용 시각은 1분에 한 번만 갱신한다
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
  }
  return { id: row.id, name: row.name };
}

