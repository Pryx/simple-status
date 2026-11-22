import type { Cursor } from "./db";
import { ProblemError } from "./problem";

/** Cursors are opaque to clients: base64url of `starts_at` and `id`. */
export function encodeCursor(cursor: Cursor): string {
  return btoa(`${cursor.starts_at} ${cursor.id}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const [starts_at, id, ...rest] = atob(value.replaceAll("-", "+").replaceAll("_", "/")).split(
      " ",
    );
    if (starts_at && id && rest.length === 0) return { starts_at, id };
  } catch {
    // Not base64; fall through.
  }
  throw new ProblemError({ title: "Bad Request", status: 400, detail: "Invalid cursor." });
}
