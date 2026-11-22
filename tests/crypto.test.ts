import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateEncryptionKey } from "../lib/crypto";

/**
 * 시험 사례 표
 *  1. 암호화 후 복호화          → 원문과 같음 (한글·긴 문자열 포함)
 *  2. 같은 값을 두 번 암호화    → 서로 다른 결과 (IV가 매번 다름)
 *  3. 암호문 한 글자 변경       → 복호화 실패
 *  4. 다른 키로 복호화          → 실패
 *  5. 키 없음 / 길이 틀림       → 오류 (메시지에 키 값이 없음)
 *  6. 형식이 다른 문자열        → 오류
 *  7. 환경변수 APP_ENC_KEY 사용 → 키를 따로 넘기지 않아도 동작
 */
const key = generateEncryptionKey();

afterEach(() => {
  delete process.env.APP_ENC_KEY;
});

describe("crypto", () => {
  it("암호화한 값을 복호화하면 원문과 같다", () => {
    for (const plain of ["JBSWY3DPEHPK3PXP", "API키-한글 ✓", "", "x".repeat(5000)]) {
      expect(decryptSecret(encryptSecret(plain, key), key)).toBe(plain);
    }
  });

  it("평문이 암호문에 그대로 드러나지 않고 버전 표시가 붙는다", () => {
    const token = encryptSecret("my-secret-api-key", key);
    expect(token.startsWith("v1:")).toBe(true);
    expect(token).not.toContain("my-secret-api-key");
  });

  it("같은 값도 매번 다른 암호문이 나온다", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("암호문이 한 글자라도 바뀌면 복호화에 실패한다", () => {
    const token = encryptSecret("secret", key);
    const body = token.slice(3);
    const flipped = body.slice(0, -4) + (body.slice(-4, -3) === "A" ? "B" : "A") + body.slice(-3);
    expect(() => decryptSecret(`v1:${flipped}`, key)).toThrow("복호화에 실패");
  });

  it("다른 키로는 복호화할 수 없다", () => {
    const token = encryptSecret("secret", key);
    expect(() => decryptSecret(token, generateEncryptionKey())).toThrow("복호화에 실패");
  });

  it("키가 없거나 길이가 틀리면 오류를 내고 메시지에 키 값을 넣지 않는다", () => {
    expect(() => encryptSecret("x")).toThrow("APP_ENC_KEY");
    const shortKey = Buffer.from("too-short").toString("base64");
    try {
      encryptSecret("x", shortKey);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("32바이트");
      expect((e as Error).message).not.toContain(shortKey);
    }
  });

  it("형식이 다른 문자열은 거부한다", () => {
    expect(() => decryptSecret("plain-text", key)).toThrow("형식");
    expect(() => decryptSecret("v2:abcd", key)).toThrow("형식");
    expect(() => decryptSecret("v1:AAAA", key)).toThrow("손상");
  });

  it("키를 넘기지 않으면 환경변수 APP_ENC_KEY를 사용한다", () => {
    process.env.APP_ENC_KEY = key;
    expect(decryptSecret(encryptSecret("from-env"))).toBe("from-env");
  });

  it("생성한 키는 base64 32바이트다", () => {
    expect(Buffer.from(generateEncryptionKey(), "base64")).toHaveLength(32);
  });
});
