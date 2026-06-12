import { useEffect, useState, Fragment } from "react";
import { Loader2, ExternalLink, Code } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CourseSection } from "@/lib/sis/types";

// Shapes returned by the read API routes (subset we render).
interface CourseCatalog {
  collegeName: string | null;
  department: string | null;
  gradingModes: string[];
  scheduleTypes: string[];
  description: string | null;
  prerequisites: string | null;
  corequisites: string | null;
}
interface RestrictionRule {
  rule: "must" | "cannot";
  category: string;
  values: string[];
}
interface Fee {
  level: string;
  description: string;
  amount: string;
}
interface SectionDetail {
  restrictions: RestrictionRule[] | null;
  fees: Fee[] | null;
  crossListCrns: string[] | null;
  linkedCrns: string[] | null;
  syllabus: string | null;
}
// Instructor name + email come straight from the section's faculty[] (always
// present in search data). Banner's contact card would add title/department/
// college, but its faculty bannerId is session-ephemeral so the card can't be
// reliably backfilled — and the extra fields are sparse/low-value. See
// docs/backfill-history.md. So the panel renders instructors from faculty[] only.

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        {action}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

interface Condition {
  course: string;
  grade: string;
  // Banner states this explicitly per condition: "yes" = may be taken
  // concurrently, "no" = may not, null = not stated.
  concurrent: "yes" | "no" | null;
}

interface ReqGroup {
  conditions: Condition[];
}

interface PrereqBlock {
  summary: string;
  groups: ReqGroup[];
  ops: ("or" | "and")[];
}

interface ParsedPrereqs {
  label: string | null;
  blocks: PrereqBlock[];
}

function parseGroupConditions(rawLines: string[]): Condition[] {
  const conditions: Condition[] = [];
  let chunk: string[] = [];

  function flush() {
    if (!chunk.length) return;
    const courseLine = chunk.find((l) => l.startsWith("Course or Test:"));
    const gradeMatch = chunk
      .find((l) => l.startsWith("Minimum Grade"))
      ?.match(/Minimum Grade of (.+)/);
    const concLine = chunk.find((l) => /may( not)? be taken concurrently/i.test(l));
    const concurrent: "yes" | "no" | null = concLine
      ? /\bnot\b/i.test(concLine)
        ? "no"
        : "yes"
      : null;
    const course = courseLine
      ? courseLine
          .replace(/^Course or Test:\s*/, "")
          // Normalize "Subject NNN to NNN" single-course ranges → "Subject NNN"
          .replace(/(\d+) to \1$/, "$1")
          .trim()
      : chunk[0];
    conditions.push({ course, grade: gradeMatch?.[1] ?? "", concurrent });
    chunk = [];
  }

  for (const line of rawLines) {
    if (line === "and") flush();
    else chunk.push(line);
  }
  flush();
  return conditions;
}

function groupKey(g: ReqGroup) {
  return g.conditions.map((c) => `${c.course}|${c.grade}|${c.concurrent}`).join(";;");
}

function parsePrereqText(raw: string): ParsedPrereqs {
  const lines = raw.split("\n");
  let label: string | null = null;
  const blocks: PrereqBlock[] = [];
  let cur: PrereqBlock | null = null;
  let seen = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "(") {
      const rawGroupLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== ")") {
        if (lines[i].trim()) rawGroupLines.push(lines[i].trim());
        i++;
      }
      if (cur) {
        const group: ReqGroup = { conditions: parseGroupConditions(rawGroupLines) };
        const key = groupKey(group);
        if (!seen.has(key)) {
          seen.add(key);
          cur.groups.push(group);
        } else {
          // Dup: remove the op that was added between the last group and this one
          if (cur.ops.length >= cur.groups.length) cur.ops.pop();
        }
      }
    } else if (line === "or" || line === "and") {
      cur?.ops.push(line as "or" | "and");
    } else if (/^(Prerequisites|Test Score|Corequisite):/i.test(line)) {
      cur = {
        summary: line.replace(/^(Prerequisites|Test Score|Corequisite):\s*/i, "").trim(),
        groups: [],
        ops: [],
      };
      blocks.push(cur);
      seen = new Set();
    } else if (line && !cur) {
      label = label ?? line;
    }
    i++;
  }

  // Trim any trailing ops left from dedup
  for (const block of blocks) {
    while (block.ops.length >= block.groups.length) block.ops.pop();
  }

  return { label, blocks };
}

function GroupCard({ group }: { group: ReqGroup }) {
  return (
    <div className="rounded border px-2.5 py-1.5">
      {group.conditions.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div className="text-xs text-muted-foreground py-0.5">and</div>
          )}
          <div className="text-sm leading-snug">
            <span>{c.course}</span>
            {c.grade && (
              <span className="text-muted-foreground ml-1.5">≥{c.grade}</span>
            )}
            {c.concurrent === "yes" && (
              <span className="text-xs text-muted-foreground ml-1.5">(concurrent ok)</span>
            )}
            {c.concurrent === "no" && (
              <span className="text-xs text-muted-foreground ml-1.5">(no concurrent)</span>
            )}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function PrereqBlockView({ block }: { block: PrereqBlock }) {
  const { summary, groups, ops } = block;

  // No parsed groups → the summary line is the only content we have. Banner's
  // compact summary (e.g. "[ACC(200&210), orBUS624] w/C-") is redundant once we
  // render structured cards, so drop it whenever groups exist.
  if (groups.length === 0) {
    return <p className="text-sm font-medium">{summary}</p>;
  }

  return (
    <div className="space-y-1">
      {groups.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && (
            <div className="flex items-center gap-2 py-0.5">
              <div className="flex-1 border-t" />
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                {ops[gi - 1] ?? "or"}
              </span>
              <div className="flex-1 border-t" />
            </div>
          )}
          <GroupCard group={group} />
        </Fragment>
      ))}
    </div>
  );
}

function PrereqDisplay({ text }: { text: string }) {
  const { blocks } = parsePrereqText(text);

  if (blocks.length === 0) {
    return <p>{text}</p>;
  }

  // The label (e.g. "Area Prerequisites") is promoted to the section heading by
  // PrereqSection, so it isn't rendered inline here.
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => (
        <PrereqBlockView key={i} block={block} />
      ))}
    </div>
  );
}

function PrereqSection({ title, text }: { title: string; text: string }) {
  const [showRaw, setShowRaw] = useState(false);
  // Promote Banner's label (almost always "Area Prerequisites") to the heading.
  const { label } = parsePrereqText(text);
  const heading = label ?? title;
  const tip = showRaw ? "Show formatted" : "Show raw source";
  return (
    <Section
      title={heading}
      action={
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                aria-pressed={showRaw}
                aria-label={tip}
                className={`cursor-pointer rounded p-0.5 hover:text-foreground ${
                  showRaw ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                <Code className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{tip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      }
    >
      {showRaw ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded border bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
          {text}
        </pre>
      ) : (
        <PrereqDisplay text={text} />
      )}
    </Section>
  );
}

function isHttp(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Renders a list of CRNs; clickable (opens/navigates the detail dialog) when
 *  `onSelectCrn` is provided, otherwise a plain comma-separated list. */
function CrnList({
  crns,
  onSelectCrn,
}: {
  crns: string[];
  onSelectCrn?: (crn: string) => void;
}) {
  if (!onSelectCrn) return <>{crns.join(", ")}</>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {crns.map((crn) => (
        <button
          key={crn}
          type="button"
          onClick={() => onSelectCrn(crn)}
          className="cursor-pointer font-mono text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {crn}
        </button>
      ))}
    </span>
  );
}

export function SectionDetails({
  section,
  onSelectCrn,
}: {
  section: CourseSection;
  /** When set, cross-listed / linked CRNs render as clickable links that open
   *  the detail dialog for that CRN (same term). */
  onSelectCrn?: (crn: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<CourseCatalog | null>(null);
  const [detail, setDetail] = useState<SectionDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    const campus = section.campusDescription;
    const courseUrl = campus
      ? `/api/course?term=${encodeURIComponent(section.term)}&campus=${encodeURIComponent(
          campus
        )}&subject=${encodeURIComponent(section.subject)}&courseNumber=${encodeURIComponent(
          section.courseNumber
        )}`
      : null;
    const sectionUrl = `/api/section?term=${encodeURIComponent(
      section.term
    )}&crn=${encodeURIComponent(section.courseReferenceNumber)}`;

    setLoading(true);
    Promise.all([
      courseUrl ? getJson<CourseCatalog>(courseUrl) : Promise.resolve(null),
      getJson<SectionDetail>(sectionUrl),
    ]).then(([cat, det]) => {
      if (cancelled) return;
      setCatalog(cat);
      setDetail(det);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [section.term, section.courseReferenceNumber]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading section details…
      </div>
    );
  }

  const hasSectionData =
    detail &&
    (detail.restrictions?.length ||
      detail.fees?.length ||
      detail.crossListCrns?.length ||
      detail.linkedCrns?.length ||
      detail.syllabus);

  return (
    <div className="grid gap-6 py-4 md:grid-cols-2">
      {/* Course-level text */}
      <div className="space-y-4">
        <Section title="Description">
          {catalog?.description ? (
            <p className="whitespace-pre-line">{catalog.description}</p>
          ) : (
            <span className="text-muted-foreground">No description available.</span>
          )}
        </Section>

        {catalog?.prerequisites && (
          <PrereqSection title="Prerequisites" text={catalog.prerequisites} />
        )}
        {catalog?.corequisites && (
          <PrereqSection title="Corequisites" text={catalog.corequisites} />
        )}

        {(catalog?.collegeName || catalog?.department) && (
          <Section title="College / Department">
            <p>
              {catalog?.collegeName ?? "—"}
              {catalog?.department ? ` · ${catalog.department}` : ""}
            </p>
          </Section>
        )}

        {(catalog?.gradingModes.length || catalog?.scheduleTypes.length) ? (
          <div className="flex flex-wrap gap-4">
            {catalog?.gradingModes.length ? (
              <Section title="Grading Modes">
                <div className="flex flex-wrap gap-1">
                  {catalog.gradingModes.map((g) => (
                    <Badge key={g} variant="secondary">
                      {g}
                    </Badge>
                  ))}
                </div>
              </Section>
            ) : null}
            {catalog?.scheduleTypes.length ? (
              <Section title="Schedule Types">
                <div className="flex flex-wrap gap-1">
                  {catalog.scheduleTypes.map((s) => (
                    <Badge key={s} variant="secondary">
                      {s}
                    </Badge>
                  ))}
                </div>
              </Section>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Section + instructor facts */}
      <div className="space-y-4">
        <Section title="Instructors">
          {section.faculty.length === 0 ? (
            <span className="text-muted-foreground">No instructor listed.</span>
          ) : (
            <ul className="space-y-2">
              {section.faculty.map((f) => (
                <li key={f.bannerId || f.displayName} className="rounded-md border p-2">
                  <div className="font-medium">
                    {f.displayName ?? "—"}
                    {f.primaryIndicator && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        (primary)
                      </span>
                    )}
                  </div>
                  {f.emailAddress && (
                    <a
                      href={`mailto:${f.emailAddress}`}
                      className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {f.emailAddress}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {detail?.restrictions?.length ? (
          <Section title="Restrictions">
            <ul className="space-y-1">
              {detail.restrictions.map((r, idx) => (
                <li key={idx}>
                  <span className="font-medium">
                    {r.rule === "must" ? "Must be enrolled in" : "Cannot be enrolled in"} {r.category}:
                  </span>{" "}
                  {r.values.join(", ")}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {detail?.fees?.length ? (
          <Section title="Fees">
            <ul className="space-y-1">
              {detail.fees.map((f, idx) => (
                <li key={idx} className="flex justify-between gap-4">
                  <span>{f.description || f.level || "Fee"}</span>
                  <span className="font-mono">{f.amount}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {detail?.crossListCrns?.length ? (
          <Section title="Cross-listed CRNs">
            <CrnList crns={detail.crossListCrns} onSelectCrn={onSelectCrn} />
          </Section>
        ) : null}
        {detail?.linkedCrns?.length ? (
          <Section title="Linked CRNs">
            <CrnList crns={detail.linkedCrns} onSelectCrn={onSelectCrn} />
          </Section>
        ) : null}

        {detail?.syllabus ? (
          <Section title="Syllabus">
            {isHttp(detail.syllabus) ? (
              <a
                href={detail.syllabus}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
              >
                View syllabus
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <p className="whitespace-pre-line">{detail.syllabus}</p>
            )}
          </Section>
        ) : null}

        {!hasSectionData && (
          <p className="text-sm text-muted-foreground">
            No additional section details.
          </p>
        )}
      </div>
    </div>
  );
}
