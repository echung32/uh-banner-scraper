/**
 * Parser for the `getSectionCatalogDetails` HTML fragment. The fragment is flat
 * and label-anchored (each field is a `<span class="status-bold">Label:</span>`
 * followed by its value), so we extract by label rather than parsing a DOM.
 *
 * Sample (from scripts/intercepted_calls.json, ICS 111 / CRN 71843):
 *   <span class="status-bold">College:</span>
 *       <span>MAN-College of Natural Sciences  14</span>
 *   <span class="status-bold">Department:</span>
 *       <span>Information&amp; Computer Sciences  ICS</span>
 *   <span class="status-bold">Grading Modes:</span>
 *       <div class="indent-left">Audit  A<br/>Credit/No Credit  C<br/>Letter Plus + Minus  G</div>
 *   <span class="status-bold">Schedule Types:</span>
 *       <div class="indent-left">Laboratory  LAB<br/>Lecture  LEC<br/>Lecture/Discussion  LED</div>
 *   <span class="indent-left">Credit Hours:</span><span class="credit-hours-direction">4  </span>
 */

export interface CatalogDetails {
  collegeCode: string | null; // "14"
  collegeName: string | null; // "College of Natural Sciences"
  department: string | null; // "Information & Computer Sciences"
  departmentCode: string | null; // "ICS"
  gradingModes: string[]; // ["Audit  A", "Credit/No Credit  C", ...]
  scheduleTypes: string[]; // ["Laboratory  LAB", "Lecture  LEC", ...]
  creditBreakdown: { creditHours: number | null };
}

/** Minimal HTML entity decode for the entities Banner actually emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Decode entities and flatten line breaks + indentation to a single space, but
 * PRESERVE internal multi-space runs — Banner delimits a value from its trailing
 * code with two-or-more spaces ("College of Natural Sciences  14"), so collapsing
 * all whitespace would destroy the delimiter splitTrailingCode relies on.
 */
function clean(s: string): string {
  return decodeEntities(s).replace(/\r?\n\s*/g, " ").trim();
}

/** Text of the first `<span>…</span>` after a `status-bold` label. */
function labelledSpan(html: string, label: string): string | null {
  const re = new RegExp(
    `${label}\\s*:\\s*</span>\\s*<span[^>]*>([\\s\\S]*?)</span>`,
    "i"
  );
  const m = re.exec(html);
  return m ? clean(m[1]) : null;
}

/** Inner items of the `<div class="indent-left">` after a `status-bold` label. */
function labelledList(html: string, label: string): string[] {
  const re = new RegExp(
    `${label}\\s*:\\s*</span>\\s*<div[^>]*>([\\s\\S]*?)</div>`,
    "i"
  );
  const m = re.exec(html);
  if (!m) return [];
  return m[1]
    .split(/<br\s*\/?>/i)
    .map((x) => clean(x))
    .filter(Boolean);
}

/**
 * Splits a "Name  CODE" cell into name + trailing code. Banner separates the
 * code from the name with two-or-more spaces (e.g. "College of Natural Sciences  14").
 */
function splitTrailingCode(value: string): { name: string; code: string | null } {
  const m = /^(.*?)\s{2,}(\S+)\s*$/.exec(value);
  if (m) return { name: m[1].trim(), code: m[2] };
  return { name: value.trim(), code: null };
}

export function parseCatalogDetails(html: string): CatalogDetails {
  // College: "MAN-College of Natural Sciences  14" → campus prefix, name, code.
  const collegeRaw = labelledSpan(html, "College");
  let collegeName: string | null = null;
  let collegeCode: string | null = null;
  if (collegeRaw) {
    const { name, code } = splitTrailingCode(collegeRaw);
    collegeCode = code;
    // Strip the leading campus prefix ("MAN-") so the name is the college itself.
    collegeName = name.replace(/^[A-Z]{2,4}-/, "").trim() || null;
  }

  const deptRaw = labelledSpan(html, "Department");
  let department: string | null = null;
  let departmentCode: string | null = null;
  if (deptRaw) {
    const { name, code } = splitTrailingCode(deptRaw);
    department = name || null;
    departmentCode = code;
  }

  const creditMatch = /Credit Hours:\s*<\/span>\s*<span[^>]*>\s*(\d+(?:\.\d+)?)/i.exec(
    html
  );

  return {
    collegeCode,
    collegeName,
    department,
    departmentCode,
    gradingModes: labelledList(html, "Grading Modes"),
    scheduleTypes: labelledList(html, "Schedule Types"),
    creditBreakdown: {
      creditHours: creditMatch ? Number(creditMatch[1]) : null,
    },
  };
}
