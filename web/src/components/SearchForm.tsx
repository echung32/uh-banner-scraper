import { useState, useEffect } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AutocompleteItem } from "@/lib/sis/types";
import {
  UH_CAMPUSES,
  DEFAULT_CAMPUS,
  ALL_CAMPUSES,
  campusDescriptionForCode,
} from "@/lib/campuses";

// Shared "no filter" sentinel for the facet selects (Radix forbids empty values).
const ALL = "ALL";

interface SearchFormProps {
  terms: AutocompleteItem[];
  onSearch: (params: {
    term: string;
    subject: string;
    courseNumber: string;
    campus: string;
    college: string;
    department: string;
    openOnly: boolean;
  }) => void;
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

export function SearchForm({ terms, onSearch, isLoading }: SearchFormProps) {
  const [term, setTerm] = useState(() => pickDefaultTerm(terms));
  const [subject, setSubject] = useState("");
  const [courseNumber, setCourseNumber] = useState("");
  const [campus, setCampus] = useState(DEFAULT_CAMPUS);
  const [college, setCollege] = useState(ALL);
  const [department, setDepartment] = useState(ALL);
  const [openOnly, setOpenOnly] = useState(false);

  const [collegeOptions, setCollegeOptions] = useState<AutocompleteItem[]>([]);
  const [departmentOptions, setDepartmentOptions] = useState<AutocompleteItem[]>([]);

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
    Promise.all([load("college"), load("department")]).then(([col, dep]) => {
      if (cancelled) return;
      setCollegeOptions(col);
      setDepartmentOptions(dep);
    });
    setCollege(ALL);
    setDepartment(ALL);
    return () => {
      cancelled = true;
    };
  }, [term, campus]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term || !subject.trim()) return;
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

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="term">Term</Label>
          <Select value={term} onValueChange={setTerm}>
            <SelectTrigger id="term">
              <SelectValue placeholder="Select a term" />
            </SelectTrigger>
            <SelectContent>
              {terms.map((t) => (
                <SelectItem key={t.code} value={t.code}>
                  {t.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="subject">Subject</Label>
          <Input
            id="subject"
            placeholder="e.g. ICS"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={10}
            required
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
          <Select value={campus} onValueChange={setCampus}>
            <SelectTrigger id="campus">
              <SelectValue placeholder="Select a campus" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CAMPUSES}>All Campuses</SelectItem>
              {UH_CAMPUSES.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="college">College</Label>
          <Select value={college} onValueChange={setCollege}>
            <SelectTrigger id="college">
              <SelectValue placeholder="All Colleges" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Colleges</SelectItem>
              {collegeOptions.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="department">Department</Label>
          <Select value={department} onValueChange={setDepartment}>
            <SelectTrigger id="department">
              <SelectValue placeholder="All Departments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Departments</SelectItem>
              {departmentOptions.map((d) => (
                <SelectItem key={d.code} value={d.code}>
                  {d.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          <Button type="submit" disabled={isLoading || !subject.trim()} className="w-full">
            <Search className="h-4 w-4" />
            {isLoading ? "Searching…" : "Search"}
          </Button>
        </div>
      </div>
    </form>
  );
}
