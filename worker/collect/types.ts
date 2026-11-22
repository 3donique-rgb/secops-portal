export type CollectedItem = { raw: string; refUrl?: string; note?: string };
export type CollectResult = {
  items: CollectedItem[];
  /** 이번에 처리한 글/파일 주소 (다음 실행에서 건너뛰기 위해 기억) */
  seen?: string[];
};
export type SourceInfo = { id: string; name: string; kind: "api" | "html" | "pdf"; url: string; config: Record<string, unknown> };
