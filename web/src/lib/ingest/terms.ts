/**
 * Term-list refresh — cheap Banner call that keeps the `term` table current and
 * recomputes `is_view_only` (so a term that flips to "(View Only)" stops being
 * revalidated). Run before/around full syncs.
 */
import { establishSession, getTerms } from "@/lib/sis/client";
import type { AutocompleteItem } from "@/lib/sis/types";
import type { D1Like } from "@/lib/db/client";
import { upsertTerms } from "@/lib/db/upsert";

// A known-recent term used only to bootstrap the handshake; the term list it
// returns is independent of which term is locked.
const BOOTSTRAP_TERM = "202510";

export async function refreshTerms(
  db: D1Like,
  bootstrapTerm: string = BOOTSTRAP_TERM
): Promise<AutocompleteItem[]> {
  const session = await establishSession(bootstrapTerm);
  const terms = await getTerms(session);
  await upsertTerms(db, terms);
  return terms;
}
