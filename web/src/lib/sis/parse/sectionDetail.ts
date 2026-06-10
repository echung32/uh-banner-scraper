/**
 * Parsers for the section-level detail fragments: getRestrictions, getFees,
 * getXlstSections (cross-list), getLinkedSections, getSyllabus. Each returns
 * structured data (or null when Banner shows a "No … information available"
 * placeholder). Samples in scripts/intercepted_calls.json.
 */

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// ── restrictions ─────────────────────────────────────────────────────────────
export interface RestrictionRule {
  rule: "must" | "cannot"; // "must be enrolled in" / "cannot be enrolled in"
  category: string; // "Levels", "Campuses", "Cohorts", "Programs", "Majors", …
  values: string[]; // e.g. "MAN-Graduate (G0)"
}

export function parseRestrictions(html: string): RestrictionRule[] | null {
  const headingRe =
    /<span class="status-bold">(Must|Cannot) be enrolled in one of the following ([^:]+):<\/span>/g;
  const heads = [...html.matchAll(headingRe)];
  if (heads.length === 0) return null;
  const rules: RestrictionRule[] = [];
  for (let i = 0; i < heads.length; i++) {
    const start = (heads[i].index ?? 0) + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index ?? html.length : html.length;
    const seg = html.slice(start, end);
    const values = [
      ...seg.matchAll(/<span class="detail-popup-indentation">([^<]*)<\/span>/g),
    ]
      .map((m) => clean(m[1]))
      .filter(Boolean);
    rules.push({
      rule: heads[i][1].toLowerCase() as "must" | "cannot",
      category: clean(heads[i][2]),
      values,
    });
  }
  return rules.length ? rules : null;
}

// ── fees ─────────────────────────────────────────────────────────────────────
export interface Fee {
  level: string;
  description: string;
  amount: string; // "$50.00", kept verbatim
}

/** Rows of the `tbody` of a section's fee table. */
export function parseFees(html: string): Fee[] | null {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/i.exec(html);
  if (!tbody) return null;
  const fees: Fee[] = [];
  for (const row of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((t) =>
      clean(t[1])
    );
    if (tds.length >= 3 && (tds[1] || tds[2])) {
      fees.push({ level: tds[0], description: tds[1], amount: tds[2] });
    }
  }
  return fees.length ? fees : null;
}

// ── cross-list / linked CRNs ─────────────────────────────────────────────────
/** First (CRN) column of each `tbody` row — used for cross-list and linked. */
export function parseSectionCrns(html: string): string[] | null {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/i.exec(html);
  if (!tbody) return null;
  const crns: string[] = [];
  for (const row of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const first = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(row[1]);
    const v = first ? clean(first[1]) : "";
    if (/^\d+$/.test(v)) crns.push(v);
  }
  return crns.length ? crns : null;
}

// ── syllabus ─────────────────────────────────────────────────────────────────
export function parseSyllabus(html: string): string | null {
  const link = /<a[^>]*href="([^"]+)"/i.exec(html);
  if (link) return link[1];
  const text = clean(html);
  if (!text || /no syllabus information available/i.test(text)) return null;
  return text;
}
