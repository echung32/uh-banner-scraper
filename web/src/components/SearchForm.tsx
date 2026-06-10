import { useState, useEffect } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import type { AutocompleteItem } from "@/lib/sis/types";
import {
  UH_CAMPUSES,
  DEFAULT_CAMPUS,
  ALL_CAMPUSES,
  campusDescriptionForCode,
} from "@/lib/campuses";

export interface SearchFormValues {
  term: string;
  subject: string;
  courseNumber: string;
  campus: string;
  college: string;
  department: string;
  openOnly: boolean;
}

interface SearchFormProps {
  terms: AutocompleteItem[];
  onSearch: (params: SearchFormValues) => void;
  isLoading: boolean;
}

/**
 * The most recent "regular" term to preselect — skipping Extension /
 * Apprenticeship / View-Only variants so the default lands on the main semester
 * (e.g. "Fall 2026", not "Fall 2026 Extension"). Terms arrive most-recent-first.
 */
function pickDefaultTerm(terms: AutocompleteItem[]): string {
  const isRegular = (desc: string) =>
    !/extension|apprenticeship|\(view only\)/i.test(desc);
  const regular = terms.find((t) => isRegular(t.description));
  return (regular ?? terms[0])?.code ?? "";
}

// Banner descriptions arrive HTML-encoded (e.g. "Auto Body Repair &amp; …");
// decode the handful of common entities so labels read naturally.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const toOptions = (items: AutocompleteItem[]): ComboboxOption[] =>
  items.map((i) => ({ value: i.code, label: decodeEntities(i.description) }));

export function SearchForm({ terms, onSearch, isLoading }: SearchFormProps) {
  const [term, setTerm] = useState(() => pickDefaultTerm(terms));
  const [subject, setSubject] = useState("");
  const [courseNumber, setCourseNumber] = useState("");
  const [campus, setCampus] = useState(DEFAULT_CAMPUS);
  const [college, setCollege] = useState("");
  const [department, setDepartment] = useState("");
  const [openOnly, setOpenOnly] = useState(false);

  const [subjectOptions, setSubjectOptions] = useState<AutocompleteItem[]>([]);
  const [collegeOptions, setCollegeOptions] = useState<AutocompleteItem[]>([]);
  const [departmentOptions, setDepartmentOptions] = useState<AutocompleteItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Subjects depend only on the term (derived from the sections present).
  // Changing term also clears the term-specific selections (subject + course
  // number) — otherwise a stale value lingers in state (the combobox shows its
  // placeholder because the old subject isn't in the new term's list, but the
  // old value is still submitted on the next search).
  useEffect(() => {
    if (!term) return;
    setSubject("");
    setCourseNumber("");
    let cancelled = false;
    fetch(`/api/filters?term=${encodeURIComponent(term)}&kind=subject`)
      .then((r) => (r.ok ? r.json() : { options: [] }))
      .then((d) => {
        if (!cancelled) setSubjectOptions((d.options ?? []) as AutocompleteItem[]);
      })
      .catch(() => {
        if (!cancelled) setSubjectOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [term]);

  // College/Department options are catalog-derived and campus-specific, so
  // refetch whenever the term or campus changes (and reset the selections).
  useEffect(() => {
    if (!term) return;
    const campusDesc =
      campus !== ALL_CAMPUSES ? campusDescriptionForCode(campus) : null;
    const qs = (kind: string) => {
      const p = new URLSearchParams({ term, kind });
      if (campusDesc) p.set("campus", campusDesc);
      return p.toString();
    };
    let cancelled = false;
    const load = (kind: string) =>
      fetch(`/api/filters?${qs(kind)}`)
        .then((r) => (r.ok ? r.json() : { options: [] }))
        .then((d) => (d.options ?? []) as AutocompleteItem[])
        .catch(() => []);
    setCatalogLoading(true);
    Promise.all([load("college"), load("department")]).then(([col, dep]) => {
      if (cancelled) return;
      setCollegeOptions(col);
      setDepartmentOptions(dep);
      setCatalogLoading(false);
    });
    setCollege("");
    setDepartment("");
    return () => {
      cancelled = true;
    };
  }, [term, campus]);

  // College/Department are catalog-derived. They're empty (so unusable) for terms
  // whose catalog isn't synced — every not-yet-backfilled ("dynamic") term, whose
  // searches run through the page cache where these filters aren't applied. Disable
  // the fields in that case so they don't look like a no-op the user can set.
  const collegeUnavailable = !catalogLoading && collegeOptions.length === 0;
  const departmentUnavailable = !catalogLoading && departmentOptions.length === 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term) return;
    onSearch({
      term,
      subject: subject.trim().toUpperCase(),
      courseNumber: courseNumber.trim(),
      campus,
      college,
      department,
      openOnly,
    });
  }

  const campusOptions: ComboboxOption[] = [
    { value: ALL_CAMPUSES, label: "All Campuses" },
    ...UH_CAMPUSES.map((c) => ({ value: c.code, label: c.description })),
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="term">Term</Label>
          <Combobox
            id="term"
            options={toOptions(terms)}
            value={term}
            onChange={setTerm}
            placeholder="Select a term"
            searchPlaceholder="Search terms…"
            emptyText="No terms."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="subject">Subject</Label>
          <Combobox
            id="subject"
            options={subjectOptions.map((s) => ({
              value: s.code,
              label: `${s.code} — ${decodeEntities(s.description)}`,
              keywords: s.description,
            }))}
            value={subject}
            onChange={setSubject}
            placeholder="All Subjects"
            searchPlaceholder="Search subjects…"
            emptyText="No subjects for this term."
            clearLabel="All Subjects"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="courseNumber">Course Number</Label>
          <Input
            id="courseNumber"
            placeholder="e.g. 111"
            value={courseNumber}
            onChange={(e) => setCourseNumber(e.target.value)}
            maxLength={10}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="campus">Campus</Label>
          <Combobox
            id="campus"
            options={campusOptions}
            value={campus}
            onChange={setCampus}
            placeholder="Select a campus"
            searchPlaceholder="Search campuses…"
            emptyText="No campuses."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="college">College</Label>
          <Combobox
            id="college"
            options={toOptions(collegeOptions)}
            value={college}
            onChange={setCollege}
            placeholder="All Colleges"
            searchPlaceholder="Search colleges…"
            emptyText="No colleges."
            clearLabel="All Colleges"
            disabled={collegeUnavailable}
          />
          {collegeUnavailable && (
            <p className="text-xs text-muted-foreground">
              Not available until this term is backfilled.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="department">Department</Label>
          <Combobox
            id="department"
            options={toOptions(departmentOptions)}
            value={department}
            onChange={setDepartment}
            placeholder="All Departments"
            searchPlaceholder="Search departments…"
            emptyText="No departments."
            clearLabel="All Departments"
            disabled={departmentUnavailable}
          />
          {departmentUnavailable && (
            <p className="text-xs text-muted-foreground">
              Not available until this term is backfilled.
            </p>
          )}
        </div>

        <div className="flex items-center space-x-2 lg:pt-8">
          <Switch
            id="openOnly"
            checked={openOnly}
            onCheckedChange={setOpenOnly}
          />
          <Label htmlFor="openOnly">Open sections only</Label>
        </div>

        <div className="flex flex-col justify-end">
          <Button type="submit" disabled={isLoading || !term} className="w-full">
            <Search className="h-4 w-4" />
            {isLoading ? "Searching…" : "Search"}
          </Button>
        </div>
      </div>
    </form>
  );
}
