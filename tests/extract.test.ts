import { describe, expect, it } from "vitest";
import { extractIndicators, refangText } from "../worker/collect/extract";
import { validateSourceConfig, validateSourceUrl } from "../lib/source-config";

/**
 * 시험 사례 표
 *  1. 방어 표기 복원      → hxxp, [.], (dot), [@] 가 문장 속에서도 복원됨
 *  2. 5종류 추출          → IP, 도메인, URL, 해시(md5/sha1/sha256), 메일 주소
 *  3. 거짓 양성 거르기    → report.pdf, image.png 같은 파일명, 해시 일부(긴 16진수), 버전 표기 일부는 지표가 아님
 *  4. URL 끝 문장부호     → "…/a.php)." 에서 )와 . 제거, URL 안의 도메인은 따로 뽑지 않음
 *  5. 중복                → 같은 값이 여러 번·다른 표기로 나와도 한 번만
 *  6. 설정 검사           → 올바른 설정 통과, 필수 항목 누락·잘못된 형식은 한국어 문구로 거부, _seen 은 제거
 */
describe("본문에서 지표 추출", () => {
  it("방어 표기를 문장 속에서도 복원한다", () => {
    expect(refangText("hxxps://evil[.]com/a and mal(dot)example, x[@]y[.]test")).toBe("https://evil.com/a and mal.example, x@y.test");
  });

  it("5종류를 모두 찾는다", () => {
    const md5 = "d41d8cd98f00b204e9800998ecf8427e";
    const sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const text = `공격 IP 198.51.100.7 와 203.0.113.0, 도메인 bad.threat.example,
      URL hxxp://phish[.]example/login?id=1, 발신자 invoice[@]mail.threat.example, 해시 ${md5} ${sha1} ${sha256}`;
    const found = Object.fromEntries(extractIndicators(text).map((n) => [n.value, n.type]));
    expect(found).toMatchObject({
      "198.51.100.7": "ip",
      "203.0.113.0": "ip",
      "bad.threat.example": "domain",
      "http://phish.example/login?id=1": "url",
      "invoice@mail.threat.example": "email",
      [md5]: "hash", [sha1]: "hash", [sha256]: "hash",
    });
    // URL 안의 도메인(phish.example)이나 메일의 도메인은 따로 지표가 되지 않는다
    expect(Object.keys(found)).not.toContain("phish.example");
    expect(Object.keys(found)).not.toContain("mail.threat.example");
  });

  it("파일 이름·긴 16진수·IP 같은 숫자 열을 지표로 착각하지 않는다", () => {
    const text = "첨부 report.pdf 와 image.PNG, 버전 1.2.3, 번호 12.34.56.78.90, 일련번호 " + "a".repeat(33);
    const values = extractIndicators(text).map((n) => n.value);
    expect(values).not.toContain("report.pdf");
    expect(values).not.toContain("image.png");
    expect(values).not.toContain("1.2.3");
    expect(values.filter((v) => /^a+$/.test(v))).toEqual([]);
    expect(values).not.toContain("12.34.56.78");
  });

  it("URL 끝의 문장부호를 떼고, 같은 값은 한 번만 낸다", () => {
    const text = "(http://evil.example/a.php). 또 hxxp://evil[.]example/a.php 다시 http://evil.example/a.php,";
    const r = extractIndicators(text);
    expect(r.map((n) => n.value)).toEqual(["http://evil.example/a.php"]);
  });
});

describe("출처 설정 검사", () => {
  it("올바른 설정은 통과하고 _seen 은 제거된다", () => {
    const r = validateSourceConfig("api", { format: "json", itemsPath: "data", valueFields: ["ioc"], _seen: ["x"] });
    expect(r).toEqual({ ok: true, config: { format: "json", itemsPath: "data", valueFields: ["ioc"] } });
    expect(validateSourceConfig("html", { linkSelector: "a.x", maxPosts: 10 }).ok).toBe(true);
    expect(validateSourceConfig("pdf", {}).ok).toBe(true);
  });

  it("틀린 설정은 이유를 알려 준다", () => {
    for (const [kind, cfg] of [
      ["api", { format: "xml" }], ["api", { format: "csv" }], ["api", { format: "json", valueFields: "ioc" }],
      ["api", { format: "text", method: "PUT" }], ["html", {}], ["html", { linkSelector: "a", maxPosts: 0 }],
      ["pdf", { maxPdfs: 999 }], ["api", [1]], ["api", null],
    ] as const) {
      const r = validateSourceConfig(kind, cfg);
      expect(r.ok, JSON.stringify(cfg)).toBe(false);
      expect(r.ok === false && r.message.length).toBeGreaterThan(5);
    }
  });

  it("주소는 http(s)만, 계정 정보 없이", () => {
    expect(validateSourceUrl("https://example.com/feed")).toBeNull();
    expect(validateSourceUrl("ftp://example.com")).not.toBeNull();
    expect(validateSourceUrl("file:///etc/passwd")).not.toBeNull();
    expect(validateSourceUrl("javascript:alert(1)")).not.toBeNull();
    expect(validateSourceUrl("https://user:pw@example.com")).not.toBeNull();
    expect(validateSourceUrl("not a url")).not.toBeNull();
  });
});
