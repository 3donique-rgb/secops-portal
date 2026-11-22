/**
 * 개발용 가짜 데이터(1.8)와 최초 관리자 생성(2.14).
 * 스크립트(scripts/)는 이 함수를 부르기만 한다 — 로직을 시험할 수 있도록 여기에 둔다.
 *
 * 가짜 데이터는 문서용 예약 주소(TEST-NET, example/test 도메인)만 쓰므로 실제 위협정보나
 * 실제 자산과 섞일 일이 없고, 지울 때 구분할 수 있도록 표시(memo = "DEMO")를 붙인다.
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { assets, indicators, sources, users } from "../db/schema";
import { hashPassword, validatePassword } from "./auth";
import { saveIndicator, type Db, type SourceRef } from "./indicators";
import { recomputeExcluded } from "./whitelist";

export const DEMO_MARK = "DEMO";
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1.8 개발용 가짜 데이터
// ---------------------------------------------------------------------------

const DEMO_SOURCES = [
  { name: "데모기관 A (API)", kind: "api" as const, url: "https://example.test/demo-a/feed" },
  { name: "데모기관 B (게시글)", kind: "html" as const, url: "https://example.test/demo-b/board" },
  { name: "데모기관 C (PDF)", kind: "pdf" as const, url: "https://example.test/demo-c/reports" },
];

/** 결과가 늘 같도록 번호로 값을 만든다 (무작위 없음). */
function demoIndicatorValues(): string[] {
  const values: string[] = [];
  const ranges = ["198.51.100", "203.0.113", "192.0.2"];
  for (let i = 1; i <= 20; i++) values.push(`${ranges[i % 3]}.${10 + i}`);
  for (let i = 1; i <= 12; i++) values.push(`bad${String(i).padStart(2, "0")}.threat.example`);
  for (let i = 1; i <= 8; i++) values.push(`hxxp://phish${i}[.]example/login/${i}`);
  const hex = (seed: number, len: number) =>
    Array.from({ length: len }, (_, k) => ((seed * 31 + k * 7) % 16).toString(16)).join("");
  values.push(hex(1, 32), hex(2, 32), hex(3, 40), hex(4, 40), hex(5, 64), hex(6, 64));
  for (let i = 1; i <= 4; i++) values.push(`invoice${i}[@]mail.threat.example`);
  return values; // 20 + 12 + 8 + 6 + 4 = 50
}

export type SeedDemoResult = {
  sources: number;
  indicators: number;
  assets: number;
  excluded: number;
};

export async function seedDemo(db: Db, now: Date = new Date()): Promise<SeedDemoResult> {
  const refs: SourceRef[] = [];
  for (const s of DEMO_SOURCES) {
    const [found] = await db.select().from(sources).where(eq(sources.name, s.name)).limit(1);
    // 가짜 출처는 수집이 돌지 않도록 "사용 안 함"으로 만든다 (실제 주소가 아니므로)
    const row = found ?? (await db.insert(sources).values({ ...s, enabled: false }).returning())[0];
    refs.push({ id: row.id, name: row.name });
  }

  const values = demoIndicatorValues();
  const ids: string[] = [];
  for (const [i, raw] of values.entries()) {
    // 기관을 돌아가며 배정하고, 일부는 두 기관에서 동시에 들어온 것으로 만든다.
    const owners = [refs[i % 3], ...(i % 5 === 0 ? [refs[(i + 1) % 3]] : [])];
    // 마지막 확인 시각을 다양하게: 대부분 최근, 일부는 90일 넘게 지난 것(만료 시험용)
    const ageDays = i % 7 === 0 ? 100 + i : i % 3;
    for (const source of owners) {
      const r = await saveIndicator(db, {
        raw,
        source,
        refUrl: `https://example.test/demo/${i + 1}`,
        now: new Date(now.getTime() - ageDays * DAY),
      });
      if (r.status !== "invalid") ids.push(r.indicatorId);
    }
  }
  if (ids.length > 0) {
    await db
      .update(indicators)
      .set({ memo: DEMO_MARK })
      .where(inArray(indicators.id, [...new Set(ids)]));
  }

  let assetCount = 0;
  for (let i = 1; i <= 10; i++) {
    const target = `demo${String(i).padStart(2, "0")}.asset.test`;
    const [found] = await db.select().from(assets).where(eq(assets.target, target)).limit(1);
    if (found) continue;
    await db.insert(assets).values({
      name: `데모 자산 ${String(i).padStart(2, "0")}`,
      target,
      owner: "홍길동(데모)",
      department: i % 2 === 0 ? "보안관제팀" : "정보시스템팀",
      importance: (i % 5) + 1,
      scanLevel: ((i + 1) % 5) + 1,
      scanPermitted: true,
      memo: DEMO_MARK,
    });
    assetCount++;
  }

  const { excluded } = await recomputeExcluded(db);
  const total = await db.select({ id: indicators.id }).from(indicators).where(eq(indicators.memo, DEMO_MARK));
  return {
    sources: refs.length,
    indicators: total.length,
    assets: assetCount,
    excluded,
  };
}

/** 가짜 데이터만 지운다 (memo = DEMO 인 지표, 데모 자산, 데모 출처). 실제 데이터는 건드리지 않는다. */
export async function clearDemo(db: Db): Promise<{ indicators: number; assets: number; sources: number }> {
  const ind = await db.delete(indicators).where(eq(indicators.memo, DEMO_MARK)).returning({ id: indicators.id });
  const ast = await db
    .delete(assets)
    .where(and(eq(assets.memo, DEMO_MARK), like(assets.target, "%.asset.test")))
    .returning({ id: assets.id });
  const src = await db.delete(sources).where(like(sources.name, "데모기관 %")).returning({ id: sources.id });
  return { indicators: ind.length, assets: ast.length, sources: src.length };
}

// ---------------------------------------------------------------------------
// 2.14 최초 관리자 생성
// ---------------------------------------------------------------------------

export type SeedAdminResult =
  | { status: "created"; username: string }
  | { status: "exists"; username: string }
  | { status: "invalid"; message: string };

/**
 * 최초 관리자 계정을 만든다. 이미 같은 아이디가 있으면 아무것도 바꾸지 않는다(여러 번 실행해도 안전).
 * OTP는 첫 로그인 때 등록한다. 비밀번호는 해시로만 저장하고 어디에도 출력하지 않는다.
 */
export async function seedAdmin(
  db: Db,
  input: { username: string; password: string; name?: string },
): Promise<SeedAdminResult> {
  const username = input.username.trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return { status: "invalid", message: "아이디는 영문·숫자·._- 3~32자여야 합니다." };
  }
  const problem = validatePassword(input.password);
  if (problem) return { status: "invalid", message: problem };

  const [found] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (found) return { status: "exists", username };

  await db.insert(users).values({
    username,
    name: input.name?.trim() || "관리자",
    passwordHash: await hashPassword(input.password),
    role: "admin",
  });
  return { status: "created", username };
}
