/**
 * Parser for the `getClassDetails` HTML fragment (the "Class Details" modal).
 * Unlike the catalog-details fragment, this one carries the section's identity —
 * CRN, section number, the *catalog* course number, and the title — so it's what
 * the CRN-lookup live fallback uses to turn a bare (term, CRN) into something it
 * can re-query through `searchResults`.
 *
 * Sample (from scripts/intercepted_calls.json, ICS 111 / CRN 71843):
 *   <span class="status-bold">CRN:</span><span id="courseReferenceNumber">71843</span><br/>
 *   <span class="status-bold">Section Number:</span><span id="sectionNumber">001</span><br/>
 *   <span class="status-bold">Subject:</span><span id="subject">Information&amp; Computer Sciences</span>
 *   <span class="status-bold">Course Number:</span>
 *     <span id="courseNumber" style="display:none;">1110</span>  ← internal padded form
 *     <span id="courseDisplay">111</span>                         ← catalog number (what search matches)
 *   <span class="status-bold">Title:</span><span id="courseTitle">Introduction to Computer Science I</span>
 */

export interface ClassDetails {
  /** CRN echoed back by Banner — confirms the section exists. */
  courseReferenceNumber: string;
  /** Catalog course number as displayed ("111") — feeds `txt_courseNumber`. */
  courseNumber: string | null;
  /** Subject *description* ("Information & Computer Sciences"), not the code. */
  subjectDescription: string | null;
  courseTitle: string | null;
}

/** Text of an element addressed by `id` (e.g. `<span id="courseDisplay">111</span>`). */
function byId(html: string, id: string): string | null {
  const re = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</`, "i");
  const m = re.exec(html);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses the class-details fragment, or returns null when it carries no CRN —
 * Banner answers an unknown CRN with a fragment that has no `courseReferenceNumber`
 * span, which is our "no such section" signal.
 */
export function parseClassDetails(html: string): ClassDetails | null {
  const crn = byId(html, "courseReferenceNumber");
  if (!crn) return null;
  return {
    courseReferenceNumber: crn,
    courseNumber: byId(html, "courseDisplay"),
    subjectDescription: byId(html, "subject"),
    courseTitle: byId(html, "courseTitle"),
  };
}
