import { type ApiConfig } from "../../lib/source-config";
import { extractIndicators } from "./extract";
import { decodeText, type Fetcher } from "./fetcher";
import type { CollectResult, SourceInfo } from "./types";

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  return [];
}

/** 쉼표 구분 한 줄을 칸으로 나눈다 (큰따옴표 안의 쉼표는 구분자가 아님). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const isComment = (l: string) => l === "" || l.startsWith("#") || l.startsWith(";") || l.startsWith("//");

export async function collectApi(source: SourceInfo, apiKey: string | null, fetcher: Fetcher): Promise<CollectResult> {
  const cfg = source.config as unknown as ApiConfig;
  const headers: Record<string, string> = {};
  let url = source.url;
  if (apiKey) {
    if (cfg.apiKeyParam) {
      const u = new URL(url);
      u.searchParams.set(cfg.apiKeyParam, apiKey);
      url = u.toString();
    } else {
      headers[cfg.authHeader ?? "Authorization"] = (cfg.authPrefix ?? "Bearer ") + apiKey;
    }
  }
  const method = cfg.method ?? "GET";
  if (method === "POST" && cfg.body) headers["Content-Type"] = "application/json";
  const res = await fetcher(url, { method, headers, body: method === "POST" && cfg.body ? JSON.stringify(cfg.body) : undefined });
  if (res.status >= 400) throw new Error(`서버가 오류를 돌려줬습니다 (HTTP ${res.status})`);
  const text = decodeText(res.body);
  const raws: string[] = [];

  if (cfg.format === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("응답이 JSON 형식이 아닙니다.");
    }
    const list = cfg.itemsPath ? getPath(data, cfg.itemsPath) : data;
    if (!Array.isArray(list)) throw new Error(`itemsPath(${cfg.itemsPath ?? "응답 전체"})에서 목록을 찾지 못했습니다.`);
    for (const item of list) {
      if (typeof item === "string") raws.push(item);
      else if (item && typeof item === "object") {
        if (!cfg.valueFields?.length) throw new Error("목록 항목이 객체이므로 valueFields(값이 있는 필드 이름)가 필요합니다.");
        for (const f of cfg.valueFields) raws.push(...strings(getPath(item, f)));
      }
    }
  } else if (cfg.format === "csv") {
    const lines = text.split(/\r?\n/).slice(cfg.skipLines ?? 0);
    for (const line of lines) {
      if (isComment(line.trim())) continue;
      const cells = splitCsvLine(line);
      for (const col of cfg.columns ?? []) if (cells[col]) raws.push(cells[col]);
    }
  } else if (cfg.mode === "free") {
    raws.push(...extractIndicators(text).map((n) => n.value));
  } else {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (isComment(t)) continue;
      raws.push(t.split(/[\s,;]+/)[0]); // 줄 맨 앞 값만 (뒤의 설명 칸은 버림)
    }
  }
  return { items: raws.filter(Boolean).map((raw) => ({ raw, refUrl: source.url })) };
}

