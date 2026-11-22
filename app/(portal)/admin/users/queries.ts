import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";

export async function getUsername(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.username ?? null;
}
