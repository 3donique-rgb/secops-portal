import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { userAllowedIps, users } from "../db/schema";
import { generateSync } from "otplib";
import {
  MAX_FAILED_ATTEMPTS,
  beginOtpSetup,
  buildOtpAuthUri,
  checkAllowedIp,
  confirmOtpSetup,
  createOtpSecret,
  getClientIp,
  hashPassword,
  recordFailedAttempt,
  renderQrDataUrl,
  resetFailedCount,
  resetUserOtp,
  unlockUser,
  validatePassword,
  verifyCredentials,
  verifyOtpCode,
  verifyPassword,
  verifyUserOtp,
} from "../lib/auth";
import { decryptSecret, generateEncryptionKey } from "../lib/crypto";
import { createTestDb, resetData } from "./helpers/test-db";

/**
 * 시험 사례 표 (2.9 비밀번호·잠금 부분. OTP·허용 IP·세션은 2.13에서 이 파일에 이어서 추가)
 *  1. 비밀번호 해시 후 검증         → 맞는 비밀번호 true, 틀린 비밀번호 false, 해시는 매번 다름
 *  2. 비밀번호 규칙                 → 9자 거부, 10자 허용, 129자 거부
 *  3. 올바른 아이디·비밀번호        → ok
 *  4. 없는 아이디                   → invalid (잘못된 비밀번호와 같은 결과)
 *  5. 틀린 비밀번호 4번              → 아직 잠기지 않음, 5번째에 잠김
 *  6. 잠긴 계정 + 맞는 비밀번호     → locked
 *  7. 잠긴 계정 + 틀린 비밀번호     → invalid (잠김 여부를 알려 주지 않음)
 *  8. 비밀번호 확인 성공            → 실패 횟수는 그대로 (OTP까지 통과해야 초기화)
 *  9. resetFailedCount              → 0으로, 마지막 로그인 시각 기록
 * 10. 관리자가 잠금 해제            → 다시 로그인 가능
 * 11. 동시에 5번 실패               → 횟수가 빠지지 않고 잠김
 *
 * OTP (2.10)
 * 12. 표준 시험값(RFC 6238) 시각 59초 → 코드 287082 (구글 오센티케이터와 같은 계산)
 * 13. 현재·앞뒤 30초 코드           → 통과, 90초 전 코드 → 실패, 숫자 6자리가 아님 → 실패
 * 14. 등록 시작                     → 비밀키는 암호화되어 저장, QR·otpauth 주소 생성
 * 15. 이미 등록된 계정의 재등록      → 거부 (관리자가 초기화해야 함)
 * 16. 등록 확인                     → 맞는 코드만 사용 시작, 틀리면 계속 미사용
 * 17. 로그인 OTP 확인               → 맞으면 ok, 틀리면 invalid + 실패 횟수 증가, 5회째 잠김
 * 18. OTP 미등록 / 잠긴 계정        → not_enrolled / locked
 * 19. 관리자 OTP 초기화             → 비밀키 삭제, 다시 등록 가능
 *
 * 허용 IP (2.11)
 * 20. 관리자                        → IP·등록 여부와 상관없이 통과
 * 21. 일반 계정 + 등록된 IP 없음     → 거부 (not_registered)
 * 22. 단일 IP 일치 / 불일치          → 통과 / 거부
 * 23. 대역(CIDR) 안 / 밖             → 통과 / 거부, IPv6 대역·IPv4 매핑 주소 지원
 * 24. 접속 IP를 알 수 없음           → 일반 계정은 거부 (no_ip)
 * 25. 다른 계정에 등록된 IP          → 적용되지 않음
 * 26. 헤더에서 접속 IP 추출          → x-forwarded-for 맨 앞, 포트·대괄호 제거, 잘못된 값은 x-real-ip로 대체
 */
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const PASSWORD = "correct-horse-battery";

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.client.close();
});
beforeEach(async () => {
  await resetData(ctx.client);
});

async function makeUser(username = "analyst1") {
  const [u] = await ctx.db
    .insert(users)
    .values({
      username,
      name: "담당자",
      passwordHash: await hashPassword(PASSWORD),
      role: "viewer",
    })
    .returning();
  return u;
}
const getUser = async (id: string) =>
  (await ctx.db.select().from(users).where(eq(users.id, id)))[0];

describe("비밀번호 해시", () => {
  it("맞는 비밀번호만 통과하고 해시는 매번 달라진다", async () => {
    const h1 = await hashPassword(PASSWORD);
    const h2 = await hashPassword(PASSWORD);
    expect(h1).not.toBe(h2);
    expect(h1.startsWith("$argon2id$")).toBe(true);
    expect(h1).not.toContain(PASSWORD);
    expect(await verifyPassword(h1, PASSWORD)).toBe(true);
    expect(await verifyPassword(h1, PASSWORD + "x")).toBe(false);
    expect(await verifyPassword(h1, "")).toBe(false);
    expect(await verifyPassword("not-a-hash", PASSWORD)).toBe(false);
  });

  it("비밀번호 규칙: 10자 이상 128자 이하", () => {
    expect(validatePassword("a".repeat(9))).not.toBeNull();
    expect(validatePassword("a".repeat(10))).toBeNull();
    expect(validatePassword("a".repeat(128))).toBeNull();
    expect(validatePassword("a".repeat(129))).not.toBeNull();
  });
});

describe("verifyCredentials (1차 인증과 5회 잠금)", () => {
  it("올바른 아이디·비밀번호는 통과한다", async () => {
    const u = await makeUser();
    const r = await verifyCredentials(ctx.db, "analyst1", PASSWORD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user.id).toBe(u.id);
  });

  it("없는 아이디와 틀린 비밀번호는 같은 결과(invalid)다", async () => {
    await makeUser();
    expect(await verifyCredentials(ctx.db, "nobody", PASSWORD)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyCredentials(ctx.db, "analyst1", "wrong-password")).toEqual({ ok: false, reason: "invalid" });
  });

  it("틀린 비밀번호가 5번째에 계정을 잠근다", async () => {
    const u = await makeUser();
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      await verifyCredentials(ctx.db, "analyst1", "wrong-password");
      const row = await getUser(u.id);
      expect(row.failedCount).toBe(i);
      expect(row.locked).toBe(false);
    }
    await verifyCredentials(ctx.db, "analyst1", "wrong-password");
    const locked = await getUser(u.id);
    expect(locked.failedCount).toBe(MAX_FAILED_ATTEMPTS);
    expect(locked.locked).toBe(true);
  });

  it("잠긴 계정은 맞는 비밀번호도 거부하지만(locked), 틀린 비밀번호에는 잠김 여부를 알리지 않는다(invalid)", async () => {
    const u = await makeUser();
    await ctx.db.update(users).set({ locked: true, failedCount: 5 }).where(eq(users.id, u.id));
    expect(await verifyCredentials(ctx.db, "analyst1", PASSWORD)).toEqual({ ok: false, reason: "locked" });
    expect(await verifyCredentials(ctx.db, "analyst1", "wrong-password")).toEqual({ ok: false, reason: "invalid" });
    // 잠긴 뒤의 실패는 횟수를 더 올리지 않는다
    expect((await getUser(u.id)).failedCount).toBe(5);
  });

  it("비밀번호 확인에 성공해도 실패 횟수는 초기화되지 않는다 (OTP 통과 후 초기화)", async () => {
    const u = await makeUser();
    await verifyCredentials(ctx.db, "analyst1", "wrong-password");
    await verifyCredentials(ctx.db, "analyst1", PASSWORD);
    expect((await getUser(u.id)).failedCount).toBe(1);

    const now = new Date("2026-11-22T00:00:00Z");
    await resetFailedCount(ctx.db, u.id, now);
    const after = await getUser(u.id);
    expect(after.failedCount).toBe(0);
    expect(after.lastLoginAt).toEqual(now);
  });

  it("관리자가 잠금을 풀면 다시 로그인할 수 있다", async () => {
    const u = await makeUser();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await verifyCredentials(ctx.db, "analyst1", "wrong-password");
    }
    expect((await verifyCredentials(ctx.db, "analyst1", PASSWORD)).ok).toBe(false);
    await unlockUser(ctx.db, u.id);
    const row = await getUser(u.id);
    expect(row).toMatchObject({ locked: false, failedCount: 0 });
    expect((await verifyCredentials(ctx.db, "analyst1", PASSWORD)).ok).toBe(true);
  });

  it("동시에 여러 번 실패해도 횟수가 빠지지 않고 잠긴다", async () => {
    const u = await makeUser();
    await Promise.all(
      Array.from({ length: MAX_FAILED_ATTEMPTS }, () => recordFailedAttempt(ctx.db, u.id)),
    );
    expect(await getUser(u.id)).toMatchObject({ failedCount: MAX_FAILED_ATTEMPTS, locked: true });
  });
});

describe("OTP (구글 오센티케이터 호환 TOTP)", () => {
  const encKey = generateEncryptionKey();
  // RFC 6238 부록의 시험용 비밀키("12345678901234567890"의 base32)
  const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("표준 시험값과 같은 코드를 계산한다", () => {
    expect(verifyOtpCode(RFC_SECRET, "287082", new Date(59 * 1000))).toBe(true);
    expect(verifyOtpCode(RFC_SECRET, "287083", new Date(59 * 1000))).toBe(false);
  });

  it("앞뒤 30초는 허용하고 그보다 오래된 코드와 형식이 틀린 입력은 거부한다", () => {
    const secret = createOtpSecret();
    const t = new Date("2026-11-22T12:00:00Z");
    const code = (offsetSec: number) =>
      generateSync({ secret, epoch: Math.floor(t.getTime() / 1000) + offsetSec });
    expect(verifyOtpCode(secret, code(0), t)).toBe(true);
    expect(verifyOtpCode(secret, code(-30), t)).toBe(true);
    expect(verifyOtpCode(secret, code(30), t)).toBe(true);
    expect(verifyOtpCode(secret, code(-90), t)).toBe(false);
    expect(verifyOtpCode(secret, code(90), t)).toBe(false);
    const c = code(0);
    expect(verifyOtpCode(secret, `${c.slice(0, 3)} ${c.slice(3)}`, t)).toBe(true); // 공백 허용
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5"]) {
      expect(verifyOtpCode(secret, bad, t), bad).toBe(false);
    }
  });

  it("otpauth 주소와 QR 이미지를 만든다", async () => {
    const uri = buildOtpAuthUri("JBSWY3DPEHPK3PXP", "analyst1");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=SecOps");
    expect(await renderQrDataUrl(uri)).toMatch(/^data:image\/png;base64,/);
  });

  it("등록을 시작하면 비밀키가 암호화되어 저장된다", async () => {
    const u = await makeUser();
    const setup = await beginOtpSetup(ctx.db, u.id, encKey);
    const row = await getUser(u.id);
    expect(row.otpEnabled).toBe(false);
    expect(row.otpSecretEnc).not.toBeNull();
    expect(row.otpSecretEnc).not.toContain(setup.secret);
    expect(decryptSecret(row.otpSecretEnc!, encKey)).toBe(setup.secret);
    expect(setup.uri).toContain(setup.secret);
    expect(setup.qrDataUrl.startsWith("data:image/png")).toBe(true);
  });

  it("앱의 코드가 맞아야 등록이 완료되고, 이미 등록된 계정은 다시 등록할 수 없다", async () => {
    const u = await makeUser();
    const { secret } = await beginOtpSetup(ctx.db, u.id, encKey);
    expect(await confirmOtpSetup(ctx.db, u.id, "000000", { encKey })).toBe(false);
    expect((await getUser(u.id)).otpEnabled).toBe(false);

    expect(await confirmOtpSetup(ctx.db, u.id, generateSync({ secret }), { encKey })).toBe(true);
    expect((await getUser(u.id)).otpEnabled).toBe(true);

    await expect(beginOtpSetup(ctx.db, u.id, encKey)).rejects.toThrow("이미 OTP");
    // 이미 사용 중인 계정에는 확인 호출이 다시 먹히지 않는다
    expect(await confirmOtpSetup(ctx.db, u.id, generateSync({ secret }), { encKey })).toBe(false);
  });

  async function enrolledUser() {
    const u = await makeUser();
    const { secret } = await beginOtpSetup(ctx.db, u.id, encKey);
    await confirmOtpSetup(ctx.db, u.id, generateSync({ secret }), { encKey });
    return { u, secret };
  }

  it("로그인 OTP: 맞는 코드는 통과, 틀리면 실패 횟수가 늘고 5회째에 잠긴다", async () => {
    const { u, secret } = await enrolledUser();
    expect(await verifyUserOtp(ctx.db, u.id, generateSync({ secret }), { encKey })).toEqual({ ok: true });
    expect((await getUser(u.id)).failedCount).toBe(0);

    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      expect(await verifyUserOtp(ctx.db, u.id, "000000", { encKey })).toEqual({ ok: false, reason: "invalid" });
      expect((await getUser(u.id)).failedCount).toBe(i);
    }
    expect(await verifyUserOtp(ctx.db, u.id, "000000", { encKey })).toEqual({ ok: false, reason: "locked" });
    expect((await getUser(u.id)).locked).toBe(true);
    // 잠긴 뒤에는 맞는 코드도 거부
    expect(await verifyUserOtp(ctx.db, u.id, generateSync({ secret }), { encKey })).toEqual({ ok: false, reason: "locked" });
  });

  it("비밀번호 실패와 OTP 실패는 같은 횟수에 합산된다", async () => {
    const { u } = await enrolledUser();
    await verifyCredentials(ctx.db, "analyst1", "wrong-password");
    await verifyCredentials(ctx.db, "analyst1", "wrong-password");
    await verifyUserOtp(ctx.db, u.id, "000000", { encKey });
    await verifyUserOtp(ctx.db, u.id, "000000", { encKey });
    expect((await getUser(u.id)).failedCount).toBe(4);
    await verifyUserOtp(ctx.db, u.id, "000000", { encKey });
    expect((await getUser(u.id)).locked).toBe(true);
  });

  it("OTP를 등록하지 않은 계정은 not_enrolled다", async () => {
    const u = await makeUser();
    expect(await verifyUserOtp(ctx.db, u.id, "123456", { encKey })).toEqual({ ok: false, reason: "not_enrolled" });
    expect((await getUser(u.id)).failedCount).toBe(0);
  });

  it("관리자가 OTP를 초기화하면 비밀키가 지워지고 다시 등록할 수 있다", async () => {
    const { u, secret } = await enrolledUser();
    await resetUserOtp(ctx.db, u.id);
    const row = await getUser(u.id);
    expect(row).toMatchObject({ otpSecretEnc: null, otpEnabled: false });
    expect(await verifyUserOtp(ctx.db, u.id, generateSync({ secret }), { encKey })).toEqual({ ok: false, reason: "not_enrolled" });
    const again = await beginOtpSetup(ctx.db, u.id, encKey);
    expect(again.secret).not.toBe(secret);
  });
});

describe("허용 IP 판정", () => {
  async function addIp(userId: string, cidr: string) {
    await ctx.db.insert(userAllowedIps).values({ userId, cidr });
  }
  const viewer = (id: string) => ({ id, role: "viewer" as const });

  it("관리자는 IP 제한 없이 통과한다 (IP를 알 수 없어도)", async () => {
    const u = await makeUser();
    for (const ip of ["8.8.8.8", null, "garbage"]) {
      expect(await checkAllowedIp(ctx.db, { id: u.id, role: "admin" }, ip)).toEqual({ allowed: true, reason: "admin" });
    }
  });

  it("등록된 IP가 없는 일반 계정은 로그인할 수 없다", async () => {
    const u = await makeUser();
    expect(await checkAllowedIp(ctx.db, viewer(u.id), "1.2.3.4")).toEqual({ allowed: false, reason: "not_registered" });
  });

  it("단일 IP는 일치할 때만 통과한다", async () => {
    const u = await makeUser();
    await addIp(u.id, "1.2.3.4/32");
    expect((await checkAllowedIp(ctx.db, viewer(u.id), "1.2.3.4")).allowed).toBe(true);
    expect(await checkAllowedIp(ctx.db, viewer(u.id), "1.2.3.5")).toEqual({ allowed: false, reason: "not_listed" });
  });

  it("대역(CIDR)과 IPv6, IPv4 매핑 주소를 지원한다", async () => {
    const u = await makeUser();
    await addIp(u.id, "10.0.0.0/24");
    await addIp(u.id, "2001:db8::/32");
    await addIp(u.id, "203.0.113.9");
    const allowed = async (ip: string) => (await checkAllowedIp(ctx.db, viewer(u.id), ip)).allowed;
    expect(await allowed("10.0.0.200")).toBe(true);
    expect(await allowed("10.0.1.1")).toBe(false);
    expect(await allowed("2001:db8:1::5")).toBe(true);
    expect(await allowed("2001:db9::1")).toBe(false);
    expect(await allowed("::ffff:203.0.113.9")).toBe(true);
  });

  it("접속 IP를 알 수 없으면 일반 계정은 거부한다", async () => {
    const u = await makeUser();
    await addIp(u.id, "0.0.0.0/0");
    for (const ip of [null, "", "not-an-ip"]) {
      expect(await checkAllowedIp(ctx.db, viewer(u.id), ip)).toEqual({ allowed: false, reason: "no_ip" });
    }
  });

  it("다른 계정에 등록된 IP는 적용되지 않는다", async () => {
    const a = await makeUser("userA");
    const b = await makeUser("userB");
    await addIp(a.id, "1.2.3.4/32");
    expect((await checkAllowedIp(ctx.db, viewer(b.id), "1.2.3.4")).allowed).toBe(false);
  });

  it("요청 헤더에서 접속 IP를 꺼낸다", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(getClientIp(h({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    expect(getClientIp(h({ "x-forwarded-for": "9.9.9.9:5555" }))).toBe("9.9.9.9");
    expect(getClientIp(h({ "x-forwarded-for": "[2001:db8::1]:443" }))).toBe("2001:db8::1");
    expect(getClientIp(h({ "x-forwarded-for": "::ffff:1.2.3.4" }))).toBe("1.2.3.4");
    expect(getClientIp(h({ "x-forwarded-for": "garbage", "x-real-ip": "7.7.7.7" }))).toBe("7.7.7.7");
    expect(getClientIp(h({ "x-real-ip": "7.7.7.7" }))).toBe("7.7.7.7");
    expect(getClientIp(h({}))).toBeNull();
  });
});
