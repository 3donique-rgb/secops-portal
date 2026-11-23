import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { newsArticles } from "../db/schema";
import type { Db } from "./indicators";
import { escapeLike } from "./indicator-query";

export type NewsFilter = { q?: string; keyword?: string };

function where(f: NewsFilter): SQL | undefined {
  const q = f.q?.trim();
  return and(
    f.keyword ? sql`${f.keyword} = any(${newsArticles.keywords})` : undefined,
    q ? or(ilike(newsArticles.title, `%${escapeLike(q)}%`), ilike(newsArticles.publisher, `%${escapeLike(q)}%`), ilike(newsArticles.body, `%${escapeLike(q)}%`)) : undefined,
  );
}

export async function searchNews(db: Db, f: NewsFilter, p: { page: number; pageSize: number }) {
  const w = where(f);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(newsArticles).where(w);
  const rows = await db
    .select({ id: newsArticles.id, title: newsArticles.title, publisher: newsArticles.publisher, publishedAt: newsArticles.publishedAt })
    .from(newsArticles)
    .where(w)
    .orderBy(desc(newsArticles.publishedAt), desc(newsArticles.createdAt))
    .limit(p.pageSize)
    .offset((p.page - 1) * p.pageSize);
  return { rows, total: n };
}

export async function getNews(db: Db, id: string) {
  const [r] = await db.select().from(newsArticles).where(eq(newsArticles.id, id)).limit(1);
  return r ?? null;
}
