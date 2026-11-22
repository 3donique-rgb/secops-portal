/**
 * 실행 로그(공개 저장소라 누구나 볼 수 있음)에 남기기 위한 오류 요약.
 * 접속 주소·비밀번호가 섞이지 않도록 원인 코드와 짧은 문구만 남기고 주소 모양은 가린다.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return "알 수 없는 오류";
  const cause = (e as { cause?: unknown }).cause;
  const c = cause && typeof cause === "object" ? (cause as { code?: unknown; message?: unknown }) : {};
  const code = typeof c.code === "string" ? c.code : "";
  const msg = typeof c.message === "string" ? c.message : "";
  const safe = msg
    .replace(/[\w.-]+\.(com|co|net|io|org)\b/gi, "[주소]")
    .replace(/\d{1,3}(\.\d{1,3}){3}/g, "[IP]")
    .replace(/[0-9a-f:]{2,}:[0-9a-f:]{2,}/gi, "[IP]")
    .replace(/postgres(ql)?:\/\/\S+/gi, "[접속주소]")
    .slice(0, 120);
  const head = e.message.split("\n")[0].replace(/params:.*/i, "").slice(0, 80);
  return [head, code && `원인코드: ${code}`, safe && `원인: ${safe}`].filter(Boolean).join(" / ");
}
