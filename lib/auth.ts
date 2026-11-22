/**
 * 로그인 판정 [고정] - design.md 4.8
 *
 * 이 파일은 단계별로 채워 간다.
 *  2.9  비밀번호 해시·검증, 5회 잠금
 *  2.10 OTP 비밀키 생성·QR·코드 검증   (구글 오센티케이터 호환 TOTP)
 *  2.11 허용 IP 판정(관리자 예외)
 *  2.12 임시 쿠키·세션 쿠키, 권한 확인
 */
import { hash, verify } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import { users } from "../db/schema";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db } from "./indicators";

/** 로그인 실패가 이 횟수에 이르면 계정이 잠긴다. */
export const MAX_FAILED_ATTEMPTS = 5;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

/** 화면에 보여 줄 오류 문구는 하나로 통일한다 (아이디 존재 여부를 알려 주지 않기 위해). */
export const LOGIN_ERROR_MESSAGE = "아이디 또는 비밀번호가 올바르지 않습니다";

// ---------------------------------------------------------------------------
// 비밀번호 해시
// ---------------------------------------------------------------------------

/** 비밀번호가 규칙에 맞으면 null, 아니면 이유를 돌려준다. */
export function validatePassword(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`;
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    return `비밀번호는 ${MAX_PASSWORD_LENGTH}자 이하여야 합니다.`;
  }
  return null;
}

/** argon2id로 해시한다. 같은 비밀번호도 매번 다른 해시가 나온다. */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

/** 해시와 비밀번호가 맞는지. 해시 형식이 이상해도 예외 없이 false. */
export async function verifyPassword(
  passwordHash: string,
  plain: string,
): Promise<boolean> {
  if (plain.length === 0 || plain.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

// 아이디가 없을 때도 같은 시간이 걸리도록 쓰는 가짜 해시 (응답 시간으로 아이디 존재 여부를 알아내는 것 방지)
let dummyHash: Promise<string> | undefined;
function getDummyHash() {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  return dummyHash;
}

// ---------------------------------------------------------------------------
// 1차 인증(아이디·비밀번호)과 5회 잠금
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;

export type CredentialResult =
  | { ok: true; user: UserRow }
  /** invalid: 아이디 또는 비밀번호 오류 (구분하지 않음), locked: 비밀번호는 맞지만 계정이 잠김 */
  | { ok: false; reason: "invalid" | "locked" };

/**
 * 아이디·비밀번호를 확인한다.
 * - 틀리면 실패 횟수를 1 올리고, 5회가 되면 계정을 잠근다.
 * - 잠긴 계정은 비밀번호가 맞아도 거부한다. 단, 비밀번호가 틀렸다면 잠김 여부를 알려 주지 않는다.
 * - 성공해도 실패 횟수는 여기서 초기화하지 않는다 (OTP까지 통과했을 때 초기화: resetFailedCount).
 */
export async function verifyCredentials(
  db: Db,
  username: string,
  password: string,
): Promise<CredentialResult> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username.trim()))
    .limit(1);

  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    return { ok: false, reason: "invalid" };
  }

  const matches = await verifyPassword(user.passwordHash, password);

  if (!matches) {
    if (!user.locked) await recordFailedAttempt(db, user.id);
    return { ok: false, reason: "invalid" };
  }
  if (user.locked) return { ok: false, reason: "locked" };
  return { ok: true, user };
}

/**
 * 실패 횟수를 1 올리고 5회 이상이면 잠근다. 한 번의 SQL로 처리해서
 * 동시에 여러 번 시도해도 횟수가 빠지지 않는다. 반환값: 갱신 후 잠김 여부.
 */
export async function recordFailedAttempt(
  db: Db,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({
      failedCount: sql`${users.failedCount} + 1`,
      locked: sql`(${users.failedCount} + 1) >= ${MAX_FAILED_ATTEMPTS}`,
    })
    .where(eq(users.id, userId))
    .returning({ locked: users.locked });
  return row?.locked ?? false;
}

/** 로그인이 모두 끝났을 때(OTP 통과) 실패 횟수를 0으로 되돌리고 마지막 로그인 시각을 기록한다. */
export async function resetFailedCount(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(users)
    .set({ failedCount: 0, lastLoginAt: now })
    .where(eq(users.id, userId));
}

/** 관리자가 잠금을 푼다. */
export async function unlockUser(db: Db, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ locked: false, failedCount: 0 })
    .where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// OTP (구글 오센티케이터 호환 TOTP: 6자리, 30초 주기, SHA-1)
// ---------------------------------------------------------------------------

/** 오센티케이터 앱에 표시되는 서비스 이름 */
export const OTP_ISSUER = "SecOps Portal";
/** 입력한 코드를 앞뒤 30초까지 허용한다 (휴대폰과 서버의 시계 차이 대비) */
export const OTP_TOLERANCE_SECONDS = 30;

/** 새 OTP 비밀키(base32)를 만든다. */
export function createOtpSecret(): string {
  return generateSecret();
}

/** 오센티케이터 앱이 읽는 otpauth:// 주소를 만든다. QR 코드에 담긴다. */
export function buildOtpAuthUri(secret: string, accountName: string): string {
  return generateURI({ issuer: OTP_ISSUER, label: accountName, secret });
}

/** otpauth 주소를 화면에 표시할 QR 이미지(data URL)로 바꾼다. */
export function renderQrDataUrl(otpAuthUri: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUri, { margin: 1, width: 240 });
}

/** 6자리 코드가 맞는지. 숫자 6자리가 아니면 계산하지 않고 false. */
export function verifyOtpCode(
  secret: string,
  token: string,
  now: Date = new Date(),
): boolean {
  const code = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;
  try {
    return verifySync({
      secret,
      token: code,
      epoch: Math.floor(now.getTime() / 1000),
      epochTolerance: OTP_TOLERANCE_SECONDS,
    }).valid;
  } catch {
    return false;
  }
}

export type OtpSetup = {
  /** 앱에 직접 입력할 때 쓰는 비밀키 (화면에 한 번만 보여 준다) */
  secret: string;
  uri: string;
  qrDataUrl: string;
};

/**
 * 최초 OTP 등록을 시작한다. 새 비밀키를 만들어 암호화해 저장하고(아직 사용 전 상태) QR을 돌려준다.
 * 이미 등록된 계정은 거부한다 — 비밀번호만 아는 사람이 OTP를 바꿔치기하지 못하도록,
 * 다시 등록하려면 관리자가 먼저 OTP를 초기화해야 한다.
 */
export async function beginOtpSetup(
  db: Db,
  userId: string,
  encKey?: string,
): Promise<OtpSetup> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("사용자를 찾을 수 없습니다.");
  if (user.otpEnabled) {
    throw new Error("이미 OTP가 등록된 계정입니다. 관리자에게 초기화를 요청하세요.");
  }
  const secret = createOtpSecret();
  await db
    .update(users)
    .set({ otpSecretEnc: encryptSecret(secret, encKey) })
    .where(eq(users.id, userId));
  const uri = buildOtpAuthUri(secret, user.username);
  return { secret, uri, qrDataUrl: await renderQrDataUrl(uri) };
}

/** 앱에 표시된 코드를 입력받아 맞으면 OTP 등록을 완료한다(사용 시작). */
export async function confirmOtpSetup(
  db: Db,
  userId: string,
  token: string,
  opts: { now?: Date; encKey?: string } = {},
): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.otpEnabled || !user.otpSecretEnc) return false;
  let secret: string;
  try {
    secret = decryptSecret(user.otpSecretEnc, opts.encKey);
  } catch {
    return false;
  }
  if (!verifyOtpCode(secret, token, opts.now)) return false;
  await db.update(users).set({ otpEnabled: true }).where(eq(users.id, userId));
  return true;
}

export type OtpResult =
  | { ok: true }
  /** invalid: 코드 불일치, locked: 실패 누적으로 계정이 잠김(또는 이미 잠김), not_enrolled: OTP 미등록 */
  | { ok: false; reason: "invalid" | "locked" | "not_enrolled" };

/**
 * 로그인 2차 인증: 등록된 계정의 OTP 코드를 확인한다.
 * 틀리면 비밀번호 실패와 같은 횟수에 합산하고, 5회가 되면 계정을 잠근다.
 * (6자리 숫자를 무작위로 대입하는 공격을 막기 위해서다.)
 * 성공해도 실패 횟수는 여기서 초기화하지 않는다 → 호출한 쪽에서 resetFailedCount.
 */
export async function verifyUserOtp(
  db: Db,
  userId: string,
  token: string,
  opts: { now?: Date; encKey?: string } = {},
): Promise<OtpResult> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, reason: "invalid" };
  if (user.locked) return { ok: false, reason: "locked" };
  if (!user.otpEnabled || !user.otpSecretEnc) {
    return { ok: false, reason: "not_enrolled" };
  }
  let matches = false;
  try {
    matches = verifyOtpCode(
      decryptSecret(user.otpSecretEnc, opts.encKey),
      token,
      opts.now,
    );
  } catch {
    matches = false;
  }
  if (matches) return { ok: true };
  const nowLocked = await recordFailedAttempt(db, userId);
  return { ok: false, reason: nowLocked ? "locked" : "invalid" };
}

/** 관리자가 계정의 OTP를 초기화한다. 다음 로그인 때 다시 등록해야 한다. */
export async function resetUserOtp(db: Db, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ otpSecretEnc: null, otpEnabled: false })
    .where(eq(users.id, userId));
}
