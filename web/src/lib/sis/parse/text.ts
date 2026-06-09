/**
 * Parsers for the course-level text fragments: getCourseDescription,
 * getSectionPrerequisites, getCorequisites. Each is an HTML `<section>` whose
 * meaningful payload is prose (description) or a `<pre>`-block prerequisite
 * expression. We flatten to text, preserving line breaks (block ends + `<pre>`
 * boundaries) since prereq logic is line-structured, and map Banner's
 * "No … information available." placeholders to null.
 *
 * Samples in scripts/intercepted_calls.json (and verified live against ICS 311
 * prereqs, which are a multi-`<pre>` table).
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

const NO_INFO = /no\s+[\w\s]*information\s+available/i;

/**
 * Flatten an HTML fragment to plain, line-structured text: drop comments, drop a
 * leading `<h3>` heading, turn block-element ends and `<pre>`/`<br>` into
 * newlines, strip remaining tags, decode entities, then trim per line and drop
 * blank lines.
 */
function fragmentToText(html: string, opts: { dropHeading?: boolean } = {}): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  if (opts.dropHeading) s = s.replace(/<h3[^>]*>[\s\S]*?<\/h3>/gi, " ");
  s = s.replace(/<\/(pre|p|tr|div|li)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Null when the fragment is empty or a "No … information available" placeholder. */
function orNull(text: string): string | null {
  return !text || NO_INFO.test(text) ? null : text;
}

export function parseCourseDescription(html: string): string | null {
  return orNull(fragmentToText(html));
}

export function parsePrerequisites(html: string): string | null {
  return orNull(fragmentToText(html, { dropHeading: true }));
}

export function parseCorequisites(html: string): string | null {
  return orNull(fragmentToText(html, { dropHeading: true }));
}
