import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiKeys, indicators, sources } from "../db/schema";
import { API_KEY_PREFIX, authenticateApiKey, createApiKey, hashApiKey, listApiKeys, revokeApiKey } from "../lib/api-keys";
import { saveIndicator } from "../lib/indicators";
import { addWhitelist } from "../lib/whitelist";
import { handleSiemRequest, parseSiemParams, toCsv } from "../lib/siem";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표
 *  1. 키 발급·저장      → 원문은 DB에 없고 해시만 있음, 목록에도 원문 없음, 이름 검증
 *  2. 인증              → 키 없음/틀림/형식 틀림/폐기 → 401, 정상 → 200, 마지막 사용 시각 기록
 *  3. 폐기              → 폐기 즉시 같은 키가 거부됨
 *  4. 제외 항목         → excluded 지표(화이트리스트·예약 IP)는 어떤 조건으로도 응답에 없음 (DB에는 남음)
 *  5. 조건              → type(여러 개), status(기본 active/inactive/all), since, limit
 *  6. 형식              → json 구조, csv(헤더·따옴표 처리), txt(값만)
 *  7. 잘못된 조건       → 400 + 원인 문구
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
let key: string;
const NOW = new Date("2026-11-22T00:00:00Z");
const day = (d: number) => new Date(Date.UTC(2026, 10, d));

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
  const r = await createApiKey(ctx.db, { name: "시험 SIEM" });
  if (!r.ok) throw new Error(r.message);
  key = r.key;
  const [a] = await ctx.db.insert(sources).values({ name: "A기관", kind: "api", url: "https://a.test" }).returning();
  const [b] = await ctx.db.insert(sources).values({ name: "B기관", kind: "html", url: "https://b.test" }).returning();
  const A = { id: a.id, name: a.name };
  const B = { id: b.id, name: b.name };
  await saveIndicator(ctx.db, { raw: "198.51.100.1", source: A, now: day(1) });
  await saveIndicator(ctx.db, { raw: "198.51.100.2", source: A, now: day(5) });
  await saveIndicator(ctx.db, { raw: "evil.example", source: A, now: day(10) });
  await saveIndicator(ctx.db, { raw: "d41d8cd98f00b204e9800998ecf8427e", source: B, now: day(12) });
  await saveIndicator(ctx.db, { raw: "mal@bad.example", source: B, now: day(15) });
  await saveIndicator(ctx.db, { raw: "hxxp://x.example/a,b\"c", source: B, now: day(18) });
  await saveIndicator(ctx.db, { raw: "10.0.0.5", source: B, now: day(19) }); // 사설 IP → 자동 제외
});

const call = (qs = "", auth: string | null = `Bearer ${key}`) =>
  handleSiemRequest(ctx.db, new Request(`https://portal.test/api/siem/indicators${qs}`, { headers: auth ? { authorization: auth } : {} }), NOW);

describe("API 키", () => {
  it("원문은 저장하지 않고 해시만 저장한다", async () => {
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    const [row] = await ctx.db.select().from(apiKeys);
    expect(row.keyHash).toBe(hashApiKey(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(JSON.stringify(await listApiKeys(ctx.db))).not.toContain(key);
    expect((await createApiKey(ctx.db, { name: "  " })).ok).toBe(false);
    expect(new Set([key, (await createApiKey(ctx.db, { name: "x" }) as { key: string }).key]).size).toBe(2);
  });

  it("키가 없거나 틀리거나 폐기되면 거부하고, 정상이면 마지막 사용 시각을 남긴다", async () => {
    expect((await call("", null)).status).toBe(401);
    expect((await call("", "Bearer wrong")).status).toBe(401);
    expect((await call("", key)).status).toBe(401); // Bearer 없이 키만
    expect((await call("", `Basic ${key}`)).status).toBe(401);
    expect((await call()).status).toBe(200);
    const [row] = await ctx.db.select().from(apiKeys);
    expect(row.lastUsedAt?.getTime()).toBe(NOW.getTime());

    expect((await revokeApiKey(ctx.db, row.id)).ok).toBe(true);
    expect((await call()).status).toBe(401);
    expect(await authenticateApiKey(ctx.db, `Bearer ${key}`)).toBeNull();
    expect((await revokeApiKey(ctx.db, "00000000-0000-0000-0000-000000000000")).ok).toBe(false);
  });
});

describe("SIEM 응답", () => {
  it("제외된 지표는 응답에 없고 DB에는 남아 있다", async () => {
    await addWhitelist(ctx.db, { type: "domain", value: "evil.example" });
    const body = await (await call()).json();
    const values = body.items.map((i: { value: string }) => i.value);
    expect(values).not.toContain("evil.example");
    expect(values).not.toContain("10.0.0.5");
    expect(body.count).toBe(5);
    expect((await ctx.db.select().from(indicators).where(eq(indicators.value, "evil.example")))).toHaveLength(1);
    // 어떤 조건을 줘도 제외 항목은 나오지 않는다 (status=all, type 지정, limit 크게)
    for (const qs of ["?status=all", "?type=domain", "?type=ip&status=all&limit=100000", "?excluded=only"]) {
      const v = (await (await call(qs)).json()).items.map((i: { value: string }) => i.value);
      expect(v).not.toContain("evil.example");
      expect(v).not.toContain("10.0.0.5");
    }
  });

  it("조건: type 여러 개, status, since, limit", async () => {
    const vals = async (qs: string) => (await (await call(qs)).json()).items.map((i: { value: string }) => i.value);
    expect((await vals("?type=ip")).sort()).toEqual(["198.51.100.1", "198.51.100.2"]);
    expect((await vals("?type=ip,domain")).sort()).toEqual(["198.51.100.1", "198.51.100.2", "evil.example"]);
    expect((await vals("?type=ip&type=email")).sort()).toEqual(["198.51.100.1", "198.51.100.2", "mal@bad.example"]);
    expect(await vals("?since=2026-11-12T00:00:00Z")).toHaveLength(3); // 12, 15, 18일
    expect(await vals("?limit=2")).toHaveLength(2);
    // 만료(비활성)는 기본에서 빠지고 status로 고를 수 있다
    await ctx.db.update(indicators).set({ status: "inactive" }).where(eq(indicators.value, "198.51.100.1"));
    expect(await vals("")).not.toContain("198.51.100.1");
    expect(await vals("?status=inactive")).toEqual(["198.51.100.1"]);
    expect(await vals("?status=all")).toContain("198.51.100.1");
  });

  it("형식: json 구조, csv, txt", async () => {
    const j = await (await call("?type=hash")).json();
    expect(j).toMatchObject({ count: 1, generated_at: NOW.toISOString() });
    expect(j.items[0]).toEqual({
      type: "hash", value: "d41d8cd98f00b204e9800998ecf8427e", hash_kind: "md5", status: "active",
      sources: ["B기관"], first_seen: day(12).toISOString(), last_seen: day(12).toISOString(),
    });
    const csvRes = await call("?format=csv");
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const csv = await csvRes.text();
    expect(csv.split("\r\n")[0]).toBe("type,value,hash_kind,status,sources,first_seen,last_seen");
    expect(csv).toContain('"http://x.example/a,b%22c"'); // 쉼표가 든 값은 따옴표로 감싼다 (정규화 단계에서 " 는 %22 로 바뀜)
    const tricky = { id: "1", type: "url", value: 'a,"b"', hashKind: null, status: "active", excluded: false, firstSeenAt: NOW, lastSeenAt: NOW, memo: null, sourceNames: ["X;Y"] } as const;
    expect(toCsv([tricky as never]).split("\r\n")[1]).toContain('"a,""b"""'); // " 는 두 번
    const txt = await (await call("?format=txt&type=ip")).text();
    expect(txt.split("\n").filter(Boolean).sort()).toEqual(["198.51.100.1", "198.51.100.2"]);
    expect(toCsv([])).toBe("type,value,hash_kind,status,sources,first_seen,last_seen\r\n");
  });

  it("잘못된 조건은 400과 원인을 돌려준다", async () => {
    for (const qs of ["?type=bogus", "?status=zzz", "?format=xml", "?since=어제", "?limit=0", "?limit=abc", "?limit=-1"]) {
      const r = await call(qs);
      expect(r.status, qs).toBe(400);
      expect((await r.json()).error).toBeTruthy();
    }
    expect(parseSiemParams(new URLSearchParams("limit=999999999"))).toMatchObject({ limit: 100000 });
  });
});
