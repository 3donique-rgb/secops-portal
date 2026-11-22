/**
 * 비밀값 암호화 [고정] - AES-256-GCM
 * OTP 비밀키와 출처 API 키를 DB에 저장할 때 쓴다. 키는 환경변수 APP_ENC_KEY(base64, 32바이트).
 *
 * 저장 형식: "v1:" + base64( 초기화 값(IV) 12바이트 + 인증 태그 16바이트 + 암호문 )
 * 같은 값을 암호화해도 매번 IV가 달라 결과가 다르고, 한 글자라도 바뀌면 복호화가 실패한다.
 * 오류 메시지에는 키나 평문을 넣지 않는다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** 새 암호화 키를 만든다 (처음 설정할 때 한 번 사용). */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LEN).toString("base64");
}

function loadKey(keyBase64?: string): Buffer {
  const text = keyBase64 ?? process.env.APP_ENC_KEY;
  if (!text) {
    throw new Error("APP_ENC_KEY 환경변수가 설정되지 않았습니다.");
  }
  const key = Buffer.from(text, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error("APP_ENC_KEY는 base64로 표현한 32바이트 값이어야 합니다.");
  }
  return key;
}

export function encryptSecret(plain: string, keyBase64?: string): string {
  const key = loadKey(keyBase64);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, body]).toString("base64")}`;
}

export function decryptSecret(token: string, keyBase64?: string): string {
  const key = loadKey(keyBase64);
  const [version, payload] = token.split(":");
  if (version !== VERSION || !payload) {
    throw new Error("지원하지 않는 암호문 형식입니다.");
  }
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error("암호문이 손상되었습니다.");
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = raw.subarray(IV_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // 키가 다르거나 내용이 바뀐 경우. 원인 세부 내용은 노출하지 않는다.
    throw new Error("복호화에 실패했습니다. 키가 다르거나 데이터가 변경되었습니다.");
  }
}
