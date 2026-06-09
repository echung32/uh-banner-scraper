import { useEffect, useState } from "react";
import { Loader2, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
interface BookstoreLink {
  label: string;
  url: string;
}
interface SectionDetail {
  restrictions: RestrictionRule[] | null;
  fees: Fee[] | null;
  crossListCrns: string[] | null;
  linkedCrns: string[] | null;
  bookstore: BookstoreLink[] | null;
  syllabus: string | null;
}
interface Instructor {
  bannerId: string;
  displayName: string | null;
  title: string | null;
  department: string | null;
  college: string | null;
  email: string | null;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function isHttp(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export function SectionDetails({ section }: { section: CourseSection }) {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<CourseCatalog | null>(null);
  const [detail, setDetail] = useState<SectionDetail | null>(null);
  // Contact-card enrichment (title/department/college) keyed by bannerId. The
  // base name + email always come from the section's own faculty[]; the card is
  // overlaid only when present (UH's contact-card endpoint is often unavailable).
  const [enrichment, setEnrichment] = useState<Record<string, Instructor>>({});

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
    const facultyIds = section.faculty.map((f) => f.bannerId).filter(Boolean);

    setLoading(true);
    Promise.all([
      courseUrl ? getJson<CourseCatalog>(courseUrl) : Promise.resolve(null),
      getJson<SectionDetail>(sectionUrl),
      Promise.all(
        facultyIds.map((id) =>
          getJson<Instructor>(`/api/instructor?bannerId=${encodeURIComponent(id)}`).then(
            (card) => [id, card] as const
          )
        )
      ),
    ]).then(([cat, det, cards]) => {
      if (cancelled) return;
      setCatalog(cat);
      setDetail(det);
      const map: Record<string, Instructor> = {};
      for (const [id, card] of cards) if (card) map[id] = card;
      setEnrichment(map);
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
      detail.bookstore?.length ||
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
          <Section title="Prerequisites">
            <p className="whitespace-pre-line">{catalog.prerequisites}</p>
          </Section>
        )}
        {catalog?.corequisites && (
          <Section title="Corequisites">
            <p className="whitespace-pre-line">{catalog.corequisites}</p>
          </Section>
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
              {section.faculty.map((f) => {
                const card = f.bannerId ? enrichment[f.bannerId] : undefined;
                return (
                  <li key={f.bannerId || f.displayName} className="rounded-md border p-2">
                    <div className="font-medium">
                      {f.displayName ?? "—"}
                      {f.primaryIndicator && (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          (primary)
                        </span>
                      )}
                    </div>
                    {card?.title && (
                      <div className="text-xs text-muted-foreground">{card.title}</div>
                    )}
                    {(card?.department || card?.college) && (
                      <div className="text-xs text-muted-foreground">
                        {[card.department, card.college].filter(Boolean).join(" · ")}
                      </div>
                    )}
                    {f.emailAddress && (
                      <a
                        href={`mailto:${f.emailAddress}`}
                        className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {f.emailAddress}
                      </a>
                    )}
                  </li>
                );
              })}
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
          <Section title="Cross-listed CRNs">{detail.crossListCrns.join(", ")}</Section>
        ) : null}
        {detail?.linkedCrns?.length ? (
          <Section title="Linked CRNs">{detail.linkedCrns.join(", ")}</Section>
        ) : null}

        {detail?.bookstore?.length ? (
          <Section title="Bookstore">
            <ul className="space-y-1">
              {detail.bookstore.map((b, idx) => (
                <li key={idx}>
                  <a
                    href={b.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {b.label || b.url}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
              ))}
            </ul>
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
