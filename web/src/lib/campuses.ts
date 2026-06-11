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

/**
 * Compact display abbreviations for the verbose `campusDescription` strings
 * Banner puts on a section, keyed by the exact description (the values observed
 * in `course_section.campus_description`). This is a superset of UH_CAMPUSES —
 * sections also carry non-campus "campus" descriptions (Distance Education,
 * Outreach College, General Funds, Off-Campus, satellite centers) that never
 * appear in the campus filter menu but still need a short label in the table.
 * The two CC contention cases are pinned per UH convention: Hawaii CC = "HCC",
 * Honolulu CC = "HonCC".
 */
const CAMPUS_ABBREVIATIONS: Record<string, string> = {
  "University of Hawaii at Manoa": "UHM",
  "University of Hawaii at Hilo": "UHH",
  "Univ of Hawaii - West Oahu": "UHWO",
  "Univ of Hawaii Maui College": "UHMC",
  "UHMau - Upper Level": "UHMau",
  "Hawaii Community College": "HCC",
  "Honolulu Community College": "HonCC",
  "Kapiolani Community College": "KapCC",
  "Kauai Community College": "KauCC",
  "Leeward Community College": "LCC",
  "Windward Community College": "WCC",
  "Waianae Educational Center-LEE": "LCC-Waianae",
  "UH Center, West Hawaii": "UHCWH",
  "Outreach College-UHM": "UHM-Out",
  "Outreach College GR Class-UHM": "UHM-OutGR",
  "Outreach Coll BUS Grad-UHM": "UHM-OutBG",
  "Distance Education": "DE",
  "General Funds": "GF",
  "Off-Campus": "Off-Campus",
};

/** Compact label for a campus description, or the original string if unmapped. */
export function abbreviateCampus(description: string | null | undefined): string {
  if (!description) return "—";
  return CAMPUS_ABBREVIATIONS[description] ?? description;
}
