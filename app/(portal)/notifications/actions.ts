"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { markAllRead, markRead } from "@/lib/notifications";
import { requireUser } from "@/lib/session";

export async function markReadAction(formData: FormData) {
  await requireUser();
  await markRead(getDb(), String(formData.get("id") ?? ""));
  revalidatePath("/notifications");
}

export async function markAllReadAction() {
  await requireUser();
  await markAllRead(getDb());
  revalidatePath("/notifications");
}
