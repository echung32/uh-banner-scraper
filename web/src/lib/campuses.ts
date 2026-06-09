/**
 * The UH system campuses, as returned by Banner's `get_campus` autocomplete
 * (code + verbatim description). Sections carry their campus only as
 * `campusDescription` (the full string) — there is no campus-code column on a
 * section — so the read-path filter maps a selected code to its description and
 * matches `course_section.campus_description`.
 *
 * Ordered with Manoa first (the default), then the other four-year campuses,
 * then the community colleges.
 */
export interface Campus {
  code: string;
  description: string;
}

export const UH_CAMPUSES: Campus[] = [
  { code: "MAN", description: "University of Hawaii at Manoa" },
  { code: "HIL", description: "University of Hawaii at Hilo" },
  { code: "WOA", description: "Univ of Hawaii - West Oahu" },
  { code: "MAU", description: "Univ of Hawaii Maui College" },
  { code: "HAW", description: "Hawaii Community College" },
  { code: "HON", description: "Honolulu Community College" },
  { code: "KAP", description: "Kapiolani Community College" },
  { code: "KAU", description: "Kauai Community College" },
  { code: "LEE", description: "Leeward Community College" },
  { code: "WIN", description: "Windward Community College" },
];

/** Default campus selection in the search form: UH Manoa. */
export const DEFAULT_CAMPUS = "MAN";

/** Sentinel for "don't filter by campus" (Radix Select forbids empty values). */
export const ALL_CAMPUSES = "ALL";

export function campusDescriptionForCode(code: string): string | null {
  return UH_CAMPUSES.find((c) => c.code === code)?.description ?? null;
}
