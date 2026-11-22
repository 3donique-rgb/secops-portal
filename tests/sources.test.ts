import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { collectRuns, sources } from "../db/schema";
import { decryptSecret, generateEncryptionKey } from "../lib/crypto";
import { createSource, getSource, listRuns, listSources, setSourceEnabled, updateSource, type SourceInput } from "../lib/sources";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표
 *  1. 등록          → 기관명·주소·설정 검사, 같은 이름 거부, API 키는 암호문으로 저장(원문 없음), 목록에는 "키 등록됨"만
 *  2. 수정          → 키 빈칸=유지, 새 키=교체, 삭제 체크=제거, 주소 바꾸면 "처리한 글 기억" 초기화, 같으면 유지
 *  3. 편집 화면 값  → _seen 은 보이지 않고 키 원문은 돌려주지 않음
 *  4. 사용 여부     → 끄고 켤 수 있음
 *  5. 이력          → 최신순, 목록에 마지막 상태·오류 표시
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const KEY = generateEncryptionKey();
beforeAll(async () => {
  process.env.APP_ENC_KEY = KEY;
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
});

const base: SourceInput = { name: "한국인터넷진흥원", kind: "api", url: "https://api.example/feed", configText: '{"format":"text"}', enabled: true };

describe("출처 관리", () => {
  it("등록 검사와 키 암호화", async () => {
    for (const bad of [
      { name: " " }, { kind: "rss" }, { url: "ftp://x" }, { configText: "{oops" }, { configText: '{"format":"xml"}' }, { configText: "[]" },
    ]) {
      expect((await createSource(ctx.db, { ...base, ...bad })).ok, JSON.stringify(bad)).toBe(false);
    }
    const r = await createSource(ctx.db, { ...base, apiKey: "SECRET-1" });
    expect(r.ok).toBe(true);
    expect((await createSource(ctx.db, base)).ok).toBe(false); // 같은 이름
    const [row] = await ctx.db.select().from(sources);
    expect(row.apiKeyEnc).not.toContain("SECRET-1");
    expect(decryptSecret(row.apiKeyEnc!)).toBe("SECRET-1");
    const list = await listSources(ctx.db);
    expect(list[0].hasKey).toBe(true);
    expect(JSON.stringify(list)).not.toContain("SECRET-1");
    expect(JSON.stringify(list)).not.toContain("v1:");
  });

  it("수정: 키 유지·교체·삭제, 주소 변경 시 기억 초기화", async () => {
    const r = await createSource(ctx.db, { ...base, apiKey: "K1" });
    if (!r.ok) throw new Error(r.message);
    await ctx.db.update(sources).set({ config: { format: "text", _seen: ["a", "b"] } }).where(eq(sources.id, r.id));
    const keyOf = async () => { const [x] = await ctx.db.select().from(sources); return x.apiKeyEnc ? decryptSecret(x.apiKeyEnc) : null; };

    expect((await updateSource(ctx.db, r.id, { ...base, name: "KISA" })).ok).toBe(true);
    expect(await keyOf()).toBe("K1"); // 빈칸 = 유지
    let [row] = await ctx.db.select().from(sources);
    expect(row.name).toBe("KISA");
    expect(row.config._seen).toEqual(["a", "b"]); // 주소 그대로 → 기억 유지

    await updateSource(ctx.db, r.id, { ...base, apiKey: "K2" });
    expect(await keyOf()).toBe("K2");
    await updateSource(ctx.db, r.id, { ...base, url: "https://api.example/v2" });
    [row] = await ctx.db.select().from(sources);
    expect(row.config._seen).toBeUndefined(); // 주소 변경 → 초기화
    await updateSource(ctx.db, r.id, { ...base, url: "https://api.example/v2", clearApiKey: true });
    expect(await keyOf()).toBeNull();
    expect((await updateSource(ctx.db, "00000000-0000-0000-0000-000000000000", base)).ok).toBe(false);
  });

  it("편집 화면 값에는 _seen 과 키 원문이 없고, 사용 여부를 바꿀 수 있다", async () => {
    const r = await createSource(ctx.db, { ...base, apiKey: "SECRET-2" });
    if (!r.ok) throw new Error(r.message);
    await ctx.db.update(sources).set({ config: { format: "text", _seen: ["a"] } }).where(eq(sources.id, r.id));
    const s = await getSource(ctx.db, r.id);
    expect(s?.config).toEqual({ format: "text" });
    expect(s?.hasKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain("SECRET-2");
    expect((await setSourceEnabled(ctx.db, r.id, false)).ok).toBe(true);
    expect((await getSource(ctx.db, r.id))?.enabled).toBe(false);
    expect(await getSource(ctx.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("이력은 최신순이고 목록에 마지막 상태가 보인다", async () => {
    const r = await createSource(ctx.db, base);
    if (!r.ok) throw new Error(r.message);
    const t = (h: number) => new Date(Date.UTC(2026, 10, 22, h));
    await ctx.db.insert(collectRuns).values([
      { sourceId: r.id, startedAt: t(1), status: "success", newCount: 3 },
      { sourceId: r.id, startedAt: t(2), status: "fail", errorMessage: "HTTP 503" },
    ]);
    expect((await listRuns(ctx.db, r.id)).map((x) => x.status)).toEqual(["fail", "success"]);
    const [s] = await listSources(ctx.db);
    expect(s).toMatchObject({ lastStatus: "fail", lastError: "HTTP 503" });
  });
});
