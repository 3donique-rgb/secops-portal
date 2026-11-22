import { describe, expect, it } from "vitest";
import { isReservedIp, normalize } from "../lib/normalize";

/**
 * 시험 사례 표 (입력 → 기대 결과)
 *  1. HXXP://Evil[.]com/a          → url,    http://evil.com/a
 *  2. 5D41402ABC4B2A76B9719D911017C592 → hash(md5), 소문자
 *  3. 8.8.8[.]8                    → ip,     8.8.8.8 (사설 아님)
 *  4. 192.168.0.10                 → ip,     reserved = true
 *  5. Evil[.]Example[.]COM.        → domain, evil.example.com
 *  6. Phish[@]Evil[.]com           → email,  phish@evil.com
 *  7. 999.1.1.1 / "hello" / ""     → 판별 불가(null)
 *  8. 해시 길이 31자리             → 판별 불가(null)
 */
describe("normalize", () => {
  it("방어 표기 URL을 복원하고 주소를 소문자로 만든다", () => {
    expect(normalize("HXXP://Evil[.]com/a")).toEqual({
      type: "url",
      value: "http://evil.com/a",
      hashKind: null,
      reserved: false,
    });
  });

  it("URL의 경로 대소문자는 유지하고 조각(#)은 버린다", () => {
    expect(normalize("https://Evil.com/Path/ABC?x=Y#frag")?.value).toBe(
      "https://evil.com/Path/ABC?x=Y",
    );
  });

  it("해시는 길이로 종류를 판별하고 소문자로 통일한다", () => {
    expect(normalize("5D41402ABC4B2A76B9719D911017C592")).toMatchObject({
      type: "hash",
      value: "5d41402abc4b2a76b9719d911017c592",
      hashKind: "md5",
    });
    expect(normalize("a".repeat(40))?.hashKind).toBe("sha1");
    expect(normalize("B".repeat(64))).toMatchObject({
      hashKind: "sha256",
      value: "b".repeat(64),
    });
  });

  it("방어 표기 IP를 복원한다 (공인 IP는 reserved가 아니다)", () => {
    expect(normalize("8.8.8[.]8")).toMatchObject({
      type: "ip",
      value: "8.8.8.8",
      reserved: false,
    });
  });

  it("사설·예약 대역 IP는 reserved로 표시한다", () => {
    for (const ip of ["192.168.0.10", "10.1.2.3", "172.16.5.5", "127.0.0.1", "169.254.1.1"]) {
      expect(normalize(ip)?.reserved, ip).toBe(true);
    }
    expect(normalize("172.32.0.1")?.reserved).toBe(false); // 172.16/12 바깥
    expect(isReservedIp("::1")).toBe(true);
    expect(isReservedIp("fe80::1")).toBe(true);
    expect(isReservedIp("2001:4860:4860::8888")).toBe(false);
  });

  it("IPv6는 압축된 표준 표기로 통일한다", () => {
    expect(normalize("2001:4860:4860:0:0:0:0:8888")?.value).toBe(
      "2001:4860:4860::8888",
    );
    expect(normalize("2001:DB8::1")?.type).toBe("ip");
  });

  it("도메인은 소문자로 만들고 끝의 점을 제거한다", () => {
    expect(normalize("Evil[.]Example[.]COM.")).toMatchObject({
      type: "domain",
      value: "evil.example.com",
    });
  });

  it("이메일(발신자 주소)은 소문자로 통일하고 [@]를 복원한다", () => {
    expect(normalize("Phish[@]Evil[.]com")).toMatchObject({
      type: "email",
      value: "phish@evil.com",
    });
    expect(normalize("phish(at)evil(dot)com")?.value).toBe("phish@evil.com");
  });

  it("판별할 수 없는 값은 null이다", () => {
    for (const bad of ["999.1.1.1", "hello", "", "   ", "a".repeat(31), "evil..com", "evil.c", "two words.com", "javascript://x"]) {
      expect(normalize(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(normalize("x".repeat(2001))).toBeNull();
  });

  it("앞뒤 공백은 제거한다", () => {
    expect(normalize("  evil.com\n")?.value).toBe("evil.com");
  });
});
