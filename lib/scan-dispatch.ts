/**
 * 수동 점검 요청: 점검은 GitHub Actions 에서 돌기 때문에, 포털은 GitHub에 "지금 실행" 신호만 보낸다.
 * 필요한 설정: Vercel 환경변수 GITHUB_DISPATCH_TOKEN (Actions 실행 권한만 있는 토큰). 토큰은 화면·로그에 내지 않는다.
 */
export const REPO = "3donique-rgb/secops-portal";
export const ACTIONS_URL = `https://github.com/${REPO}/actions/workflows/scan.yml`;
export const MAX_MANUAL = 50;

export type DispatchResult = { ok: true } | { ok: false; message: string };

export async function dispatchScan(assetIds: string[], token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<DispatchResult> {
  if (!token) return { ok: false, message: "수동 점검 연결이 아직 설정되지 않았습니다. docs/usage.md의 '수동 점검 설정'을 따라 GITHUB_DISPATCH_TOKEN을 등록하세요." };
  if (assetIds.length === 0 || assetIds.length > MAX_MANUAL) return { ok: false, message: `자산을 1~${MAX_MANUAL}개 선택하세요.` };
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${REPO}/actions/workflows/scan.yml/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "secops-portal",
      },
      body: JSON.stringify({ ref: "main", inputs: { asset_ids: assetIds.join(",") } }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    return { ok: false, message: "GitHub에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요." };
  }
  if (res.status === 204) return { ok: true };
  if (res.status === 401) return { ok: false, message: "GitHub 토큰이 거절되었습니다. 만료되었거나 잘못된 토큰입니다." };
  if (res.status === 403 || res.status === 404) return { ok: false, message: "GitHub 토큰에 이 저장소의 Actions 실행 권한이 없습니다. 토큰 권한을 확인하세요." };
  if (res.status === 422) return { ok: false, message: "GitHub가 요청을 받지 않았습니다. 점검 워크플로 설정이 최신인지 확인하세요." };
  return { ok: false, message: `GitHub가 오류를 돌려줬습니다 (HTTP ${res.status}).` };
}
