import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { userAllowedIps, users } from "../db/schema";
import { SignJWT } from "jose";
import { generateSync } from "otplib";
import {
  MAX_FAILED_ATTEMPTS,
  beginOtpSetup,
  buildOtpAuthUri,
  checkAllowedIp,
  confirmOtpSetup,
  cookieOptions,
  createOtpSecret,
  createPreAuthToken,
  createSessionToken,
  ForbiddenError,
  getClientIp,
  getSessionUser,
  hasRole,
  hashPassword,
  PRE_AUTH_TTL_SECONDS,
  readPreAuthToken,
  readSessionToken,
  requireRole,
  SESSION_TTL_SECONDS,
  UnauthorizedError,
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
 *
 * 세션·권한 (2.12)
 * 27. 임시/세션 토큰               → 서로 바꿔 쓸 수 없음
 * 28. 유효 시간                    → 임시 5분, 세션 8시간. 직전까지 유효, 1초 지나면 무효
 * 29. 변조·다른 키·서명 없는 토큰   → 무효
 * 30. SESSION_SECRET 없음/짧음      → 오류
 * 31. 현재 사용자 확인              → 잠김·삭제·OTP 초기화·역할 변경이 즉시 반영
 * 32. 권한 확인                    → 로그인 안 함 401, 조회전용이 관리자 화면 403, 관리자는 모두 통과
 *
 * 전체 로그인 흐름 (2.13): 비밀번호 → 잠김 → 허용 IP → 임시 쿠키 → OTP → 세션
 * 33. 조회전용: 허용 IP에서 정상 로그인        → 세션 발급, 실패 횟수 초기화
 * 34. 조회전용: 허용되지 않은 IP               → 임시 쿠키도 발급되지 않음
 * 35. 관리자: 아무 IP에서 비밀번호+OTP 통과     → 로그인
 * 36. 비밀번호만 통과(OTP 없음)               → 세션이 없어 어떤 화면도 못 봄
 * 37. 임시 토큰을 세션 쿠키 자리에 넣기         → 거부
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
  it("잠금 기준은 5회다 [고정]", () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
  });

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

describe("세션 토큰과 권한", () => {
  const SECRET = "test-session-secret-0123456789-abcdefghij";
  const T = new Date("2026-11-22T00:00:00Z");
  const after = (sec: number) => new Date(T.getTime() + sec * 1000);

  it("임시 토큰과 세션 토큰은 서로 바꿔 쓸 수 없다", async () => {
    const pre = await createPreAuthToken("u1", T, SECRET);
    const ses = await createSessionToken("u1", T, SECRET);
    expect(await readPreAuthToken(pre, T, SECRET)).toBe("u1");
    expect(await readSessionToken(ses, T, SECRET)).toBe("u1");
    expect(await readSessionToken(pre, T, SECRET)).toBeNull();
    expect(await readPreAuthToken(ses, T, SECRET)).toBeNull();
  });

  it("유효 시간: 임시 5분, 세션 8시간 (직전까지 유효, 1초 지나면 무효)", async () => {
    const pre = await createPreAuthToken("u1", T, SECRET);
    const ses = await createSessionToken("u1", T, SECRET);
    expect(await readPreAuthToken(pre, after(PRE_AUTH_TTL_SECONDS - 1), SECRET)).toBe("u1");
    expect(await readPreAuthToken(pre, after(PRE_AUTH_TTL_SECONDS + 1), SECRET)).toBeNull();
    expect(await readSessionToken(ses, after(SESSION_TTL_SECONDS - 1), SECRET)).toBe("u1");
    expect(await readSessionToken(ses, after(SESSION_TTL_SECONDS + 1), SECRET)).toBeNull();
    expect(SESSION_TTL_SECONDS).toBe(8 * 3600);
  });

  it("변조되었거나 다른 키로 서명했거나 서명이 없는 토큰은 무효다", async () => {
    const ses = await createSessionToken("u1", T, SECRET);
    const [h, p, sig] = ses.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ purpose: "session", sub: "admin-id", exp: 9999999999 })).toString("base64url");
    expect(await readSessionToken(`${h}.${forgedPayload}.${sig}`, T, SECRET)).toBeNull();
    expect(await readSessionToken(`${h}.${p}.${sig.slice(0, -2)}xx`, T, SECRET)).toBeNull();
    expect(await readSessionToken(ses, T, "another-secret-another-secret-another-")).toBeNull();
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${p}.`;
    expect(await readSessionToken(unsigned, T, SECRET)).toBeNull();
    // 같은 키로 서명했어도 용도(purpose)가 없으면 무효
    const noPurpose = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("u1").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
    expect(await readSessionToken(noPurpose, new Date(), SECRET)).toBeNull();
    for (const bad of [null, undefined, "", "abc", "a.b.c"]) {
      expect(await readSessionToken(bad, T, SECRET)).toBeNull();
    }
  });

  it("SESSION_SECRET이 없거나 32자 미만이면 오류를 낸다", async () => {
    delete process.env.SESSION_SECRET;
    await expect(createSessionToken("u1", T)).rejects.toThrow("SESSION_SECRET");
    await expect(createSessionToken("u1", T, "short")).rejects.toThrow("32자");
  });

  it("쿠키 설정은 HttpOnly이고 만료 시간이 들어 있다", () => {
    expect(cookieOptions(SESSION_TTL_SECONDS)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  });

  async function enrolled(role: "admin" | "viewer" = "viewer", username = "analyst1") {
    const u = await makeUser(username);
    if (role === "admin") await ctx.db.update(users).set({ role }).where(eq(users.id, u.id));
    const key = generateEncryptionKey();
    const { secret } = await beginOtpSetup(ctx.db, u.id, key);
    await confirmOtpSetup(ctx.db, u.id, generateSync({ secret }), { encKey: key });
    return { u, secret, key };
  }

  it("현재 사용자 확인은 DB 상태(잠김·삭제·OTP 초기화·역할 변경)를 바로 반영한다", async () => {
    const { u } = await enrolled();
    const token = await createSessionToken(u.id, T, SECRET);
    expect(await getSessionUser(ctx.db, token, T, SECRET)).toMatchObject({ id: u.id, role: "viewer", username: "analyst1" });

    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.id, u.id));
    expect((await getSessionUser(ctx.db, token, T, SECRET))?.role).toBe("admin");

    await ctx.db.update(users).set({ locked: true }).where(eq(users.id, u.id));
    expect(await getSessionUser(ctx.db, token, T, SECRET)).toBeNull();
    await unlockUser(ctx.db, u.id);
    expect(await getSessionUser(ctx.db, token, T, SECRET)).not.toBeNull();

    await resetUserOtp(ctx.db, u.id);
    expect(await getSessionUser(ctx.db, token, T, SECRET)).toBeNull();

    await ctx.db.delete(users).where(eq(users.id, u.id));
    expect(await getSessionUser(ctx.db, token, T, SECRET)).toBeNull();
  });

  it("권한 확인: 로그인 안 함 401, 조회전용이 관리자 기능 403, 관리자는 모두 통과", () => {
    const viewerUser = { id: "1", username: "v", name: "v", role: "viewer" as const };
    const adminUser = { ...viewerUser, id: "2", role: "admin" as const };
    expect(() => requireRole(null, "viewer")).toThrow(UnauthorizedError);
    expect(() => requireRole(viewerUser, "admin")).toThrow(ForbiddenError);
    expect(requireRole(viewerUser, "viewer")).toBe(viewerUser);
    expect(requireRole(adminUser, "admin")).toBe(adminUser);
    expect(requireRole(adminUser, "viewer")).toBe(adminUser);
    expect(hasRole(undefined, "viewer")).toBe(false);
  });
});

describe("전체 로그인 흐름", () => {
  const SECRET = "test-session-secret-0123456789-abcdefghij";
  const T = new Date("2026-11-22T09:00:00Z");

  /** design.md 4.8의 순서를 그대로 따라가는 시험용 조립: 비밀번호 → 잠김 → 허용 IP → 임시 → OTP → 세션 */
  async function login(opts: { username: string; password: string; ip: string | null; otp?: (secret: string) => string; secret?: string; key: string }) {
    const cred = await verifyCredentials(ctx.db, opts.username, opts.password);
    if (!cred.ok) return { stage: "password" as const, reason: cred.reason };
    const ipCheck = await checkAllowedIp(ctx.db, cred.user, opts.ip);
    if (!ipCheck.allowed) return { stage: "ip" as const, reason: ipCheck.reason };
    const pre = await createPreAuthToken(cred.user.id, T, SECRET);
    const userId = await readPreAuthToken(pre, T, SECRET);
    if (!userId || !opts.otp || !opts.secret) return { stage: "otp-pending" as const, pre };
    const otp = await verifyUserOtp(ctx.db, userId, opts.otp(opts.secret), { encKey: opts.key, now: T });
    if (!otp.ok) return { stage: "otp" as const, reason: otp.reason };
    await resetFailedCount(ctx.db, userId, T);
    return { stage: "done" as const, session: await createSessionToken(userId, T, SECRET) };
  }

  async function account(role: "admin" | "viewer", username: string, allowedIp?: string) {
    const u = await makeUser(username);
    if (role === "admin") await ctx.db.update(users).set({ role }).where(eq(users.id, u.id));
    if (allowedIp) await ctx.db.insert(userAllowedIps).values({ userId: u.id, cidr: allowedIp });
    const key = generateEncryptionKey();
    const { secret } = await beginOtpSetup(ctx.db, u.id, key);
    await confirmOtpSetup(ctx.db, u.id, generateSync({ secret, epoch: Math.floor(T.getTime() / 1000) }), { encKey: key, now: T });
    return { u, secret, key };
  }
  const goodOtp = (secret: string) => generateSync({ secret, epoch: Math.floor(T.getTime() / 1000) });

  it("조회전용 계정이 허용 IP에서 정상 로그인하면 세션이 발급되고 실패 횟수가 초기화된다", async () => {
    const { u, secret, key } = await account("viewer", "analyst1", "203.0.113.0/24");
    await verifyCredentials(ctx.db, "analyst1", "wrong-password"); // 실패 1회
    expect((await getUser(u.id)).failedCount).toBe(1);

    const r = await login({ username: "analyst1", password: PASSWORD, ip: "203.0.113.50", otp: goodOtp, secret, key });
    expect(r.stage).toBe("done");
    if (r.stage !== "done") return;
    expect(await getSessionUser(ctx.db, r.session, T, SECRET)).toMatchObject({ id: u.id, role: "viewer" });
    const row = await getUser(u.id);
    expect(row.failedCount).toBe(0);
    expect(row.lastLoginAt).toEqual(T);
  });

  it("허용되지 않은 IP에서는 임시 쿠키도 발급되지 않는다", async () => {
    const { secret, key } = await account("viewer", "analyst1", "203.0.113.0/24");
    const r = await login({ username: "analyst1", password: PASSWORD, ip: "198.51.100.1", otp: goodOtp, secret, key });
    expect(r).toEqual({ stage: "ip", reason: "not_listed" });
  });

  it("관리자는 허용 IP 등록 없이 어느 IP에서든 비밀번호와 OTP로 로그인한다", async () => {
    const { u, secret, key } = await account("admin", "boss");
    const r = await login({ username: "boss", password: PASSWORD, ip: "198.51.100.1", otp: goodOtp, secret, key });
    expect(r.stage).toBe("done");
    if (r.stage === "done") expect((await getSessionUser(ctx.db, r.session, T, SECRET))?.id).toBe(u.id);
  });

  it("관리자도 OTP를 틀리면 로그인하지 못하고, 5회 틀리면 잠긴다", async () => {
    const { secret, key } = await account("admin", "boss");
    let last: Awaited<ReturnType<typeof login>> | undefined;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      last = await login({ username: "boss", password: PASSWORD, ip: "1.1.1.1", otp: () => "000000", secret, key });
      expect(last.stage).toBe("otp");
    }
    expect(last).toEqual({ stage: "otp", reason: "locked" });
    // 잠긴 뒤에는 맞는 비밀번호·OTP도 거부
    expect(await login({ username: "boss", password: PASSWORD, ip: "1.1.1.1", otp: goodOtp, secret, key })).toEqual({ stage: "password", reason: "locked" });
  });

  it("비밀번호만 통과하고 OTP를 입력하지 않으면 세션이 없어 어떤 화면도 볼 수 없다", async () => {
    await account("admin", "boss");
    const key = generateEncryptionKey();
    const r = await login({ username: "boss", password: PASSWORD, ip: "1.1.1.1", key });
    expect(r.stage).toBe("otp-pending");
    if (r.stage !== "otp-pending") return;
    expect(await getSessionUser(ctx.db, r.pre, T, SECRET)).toBeNull();
  });

  it("OTP를 등록하지 않은 계정은 세션을 받을 수 없다", async () => {
    const u = await makeUser("newbie");
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.id, u.id));
    const session = await createSessionToken(u.id, T, SECRET);
    expect(await getSessionUser(ctx.db, session, T, SECRET)).toBeNull();
  });
});
