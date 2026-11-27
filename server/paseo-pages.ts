// Reading a whole Paseo list, page by page.

import { withTimeout } from "./thread-port";

export interface Page<T> {
  entries?: T[];
  pageInfo?: { nextCursor?: string | null; hasMore?: boolean };
}

/** Every entry of a paged Paseo list, at most `max`. Stops when the daemon says there is no more. */
export async function every<T>(list: (cursor: string | undefined) => Promise<Page<T>>, max = 5_000): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  while (all.length < max) {
    const page = await withTimeout(list(cursor), 30_000, "listing");
    all.push(...(page.entries ?? []));
    const next = page.pageInfo?.nextCursor;
    if (!page.pageInfo?.hasMore || !next || next === cursor) break;
    cursor = next;
  }
  return all;
}
