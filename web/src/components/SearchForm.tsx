import { useState } from "react";
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

interface SearchFormProps {
  terms: AutocompleteItem[];
  onSearch: (params: {
    term: string;
    subject: string;
    courseNumber: string;
    openOnly: boolean;
  }) => void;
  isLoading: boolean;
}

export function SearchForm({ terms, onSearch, isLoading }: SearchFormProps) {
  const [term, setTerm] = useState(terms[0]?.code ?? "");
  const [subject, setSubject] = useState("");
  const [courseNumber, setCourseNumber] = useState("");
  const [openOnly, setOpenOnly] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term || !subject.trim()) return;
    onSearch({ term, subject: subject.trim().toUpperCase(), courseNumber: courseNumber.trim(), openOnly });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

        <div className="flex flex-col justify-end space-y-2">
          <div className="flex items-center space-x-2">
            <Switch
              id="openOnly"
              checked={openOnly}
              onCheckedChange={setOpenOnly}
            />
            <Label htmlFor="openOnly">Open sections only</Label>
          </div>
          <Button type="submit" disabled={isLoading || !subject.trim()} className="w-full">
            <Search className="h-4 w-4" />
            {isLoading ? "Searching…" : "Search"}
          </Button>
        </div>
      </div>
    </form>
  );
}
