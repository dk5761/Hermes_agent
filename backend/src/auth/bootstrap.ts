import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword } from "./password.js";
import type { AppLogger } from "../logger.js";

export interface BootstrapInput {
  db: Db;
  logger: AppLogger;
  username?: string | undefined;
  password?: string | undefined;
}

export async function bootstrapSingleUserIfEmpty(input: BootstrapInput): Promise<void> {
  const existing = await input.db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) {
    return;
  }
  if (!input.username || !input.password) {
    input.logger.warn(
      "users table empty and BOOTSTRAP_USERNAME/BOOTSTRAP_PASSWORD not set — run pnpm seed:user to create the account",
    );
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const passwordHash = await hashPassword(input.password);
  await input.db.insert(users).values({
    id: crypto.randomUUID(),
    username: input.username,
    passwordHash,
    createdAt: now,
  });
  input.logger.info({ username: input.username }, "bootstrap user created");
}

export async function upsertUserPassword(db: Db, username: string, password: string): Promise<"created" | "updated"> {
  const now = Math.floor(Date.now() / 1000);
  const passwordHash = await hashPassword(password);
  const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (existing.length > 0) {
    await db.update(users).set({ passwordHash }).where(eq(users.username, username));
    return "updated";
  }
  await db.insert(users).values({
    id: crypto.randomUUID(),
    username,
    passwordHash,
    createdAt: now,
  });
  return "created";
}
