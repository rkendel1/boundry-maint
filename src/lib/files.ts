import { mkdir, readFile, rename, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${path} failed validation:\n${issues}`);
  }
  return parsed.data;
}

/** Read a previously generated artifact; missing or invalid files yield null (treated as "no prior state"). */
export async function readJsonIfValid<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return await readJson(path, schema);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`warning: ignoring prior artifact ${path}: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Write a set of files so that either all of them land or none do: each file is
 * written to a temp sibling first, then all are renamed into place.
 */
export async function writeAllAtomic(files: Record<string, unknown>): Promise<void> {
  const staged: [string, string][] = [];
  try {
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, typeof value === "string" ? value : stableJson(value));
      staged.push([tmp, path]);
    }
  } catch (e) {
    await Promise.all(staged.map(([tmp]) => rm(tmp, { force: true })));
    throw e;
  }
  for (const [tmp, path] of staged) await rename(tmp, path);
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}
