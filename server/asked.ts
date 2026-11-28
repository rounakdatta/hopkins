// Which question a run asks: a short mark of its report. An answer carries the mark of the question
// it answers (from the Today card, or from the conversation's needs-you message), so an answer
// meant for one question is never taken for a newer one the run asked meanwhile.

import { createHash } from "node:crypto";

export function askedIdOf(report: string | null | undefined): string {
  return createHash("sha256").update(report ?? "").digest("hex").slice(0, 12);
}
