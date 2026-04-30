import readline from "node:readline";
import { Writable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { buildLogger } from "../src/logger.js";
import { openDb } from "../src/db/client.js";
import { upsertUserPassword } from "../src/auth/bootstrap.js";

interface MutableMuted extends Writable {
  muted: boolean;
}

function makeMutedStdout(): MutableMuted {
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!(this as unknown as MutableMuted).muted) {
        process.stdout.write(chunk);
      }
      cb();
    },
  }) as MutableMuted;
  out.muted = false;
  return out;
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans)));
}

function promptHidden(rl: readline.Interface, out: MutableMuted, question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    out.muted = true;
    rl.question("", (ans) => {
      out.muted = false;
      process.stdout.write("\n");
      resolve(ans);
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger(config);
  const dbHandle = openDb(config.DATABASE_URL);

  const out = makeMutedStdout();
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });

  try {
    const username = (await prompt(rl, "Username: ")).trim();
    if (!username) throw new Error("username is required");
    const password = await promptHidden(rl, out, "Password: ");
    if (!password || password.length < 8) throw new Error("password must be >= 8 chars");
    const confirm = await promptHidden(rl, out, "Confirm:  ");
    if (password !== confirm) throw new Error("passwords do not match");

    const result = await upsertUserPassword(dbHandle.db, username, password);
    logger.info({ username, result }, "seed-user done");
  } finally {
    rl.close();
    dbHandle.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("seed-user failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
