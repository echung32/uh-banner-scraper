export interface SisSession {
  jsessionId: string;
  bigipCookie: string;
  tokenA: string;
  tokenB: string;
  uniqueSessionId: string;
  termCode: string;
  establishedAt: number;
}

export interface AutocompleteItem {
  code: string;
  description: string;
}

export interface MeetingTime {
  beginTime: string | null;
  endTime: string | null;
  // Banner names these `startDate`/`endDate` in the meetingTime payload (NOT
  // `beginDate`). The field name must match exactly: sections are reconstructed
  // verbatim from the stored raw_json, so a mismatched name reads as undefined.
  startDate: string | null;
  endDate: string | null;
  building: string | null;
  buildingDescription: string | null;
  campus: string | null;
  campusDescription: string | null;
  room: string | null;
  creditHourSession: number | null;
  hoursWeek: number | null;
  meetingScheduleType: string | null;
  meetingType: string | null;
  meetingTypeDescription: string | null;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
}

export interface MeetingFaculty {
  bannerId: string | null;
  category: string | null;
  courseReferenceNumber: string;
  displayName: string | null;
  emailAddress: string | null;
  primaryIndicator: boolean;
  term: string;
  meetingTime: MeetingTime;
}

export interface Faculty {
  bannerId: string;
  category: string | null;
  courseReferenceNumber: string;
  displayName: string | null;
  emailAddress: string | null;
  primaryIndicator: boolean;
  term: string;
}

export interface CourseSection {
  id: number;
  term: string;
  termDesc: string | null;
  courseReferenceNumber: string;
  partOfTerm: string | null;
  courseNumber: string;
  subject: string;
  subjectDescription: string | null;
  sequenceNumber: string;
  campusDescription: string | null;
  scheduleTypeDescription: string | null;
  courseTitle: string;
  creditHours: number | null;
  creditHourLow: number | null;
  creditHourHigh: number | null;
  maximumEnrollment: number;
  enrollment: number;
  seatsAvailable: number;
  waitCapacity: number;
  waitCount: number;
  waitAvailable: number;
  openSection: boolean;
  linkIdentifier: string | null;
  isSectionLinked: boolean;
  subjectCourse: string;
  faculty: Faculty[];
  meetingsFaculty: MeetingFaculty[];
  reservedSeatSummary: null;
  sectionAttributes: Array<{ code: string; description: string }>;
}

/**
 * Cache-coverage summary for one search (current sort + filters). Two flavors,
 * keyed by `mode`:
 *  - `"page-cache"` (dynamic terms): windows fill on demand; `cachedCount` grows
 *    as users page through. `dynamic` is true.
 *  - `"backfill"` (fully-synced terms): every window is present, so
 *    `cachedChunks === totalChunks` and `cachedCount === totalCount`; the grid is
 *    a data-freshness *view* (per-window `synced_at` age), not cached-vs-not.
 * Windows are fixed `chunkSize`-section slices; see `search_chunk` /
 * lib/ingest/pageCache (page-cache) and queries.getBackfillCoverage* (backfill).
 */
export interface SearchCoverage {
  mode: "page-cache" | "backfill";
  /** Convenience alias for `mode === "page-cache"` (kept for back-compat). */
  dynamic: boolean;
  chunkSize: number;
  /** Windows that would cover the whole result set (ceil(totalCount / chunkSize)). */
  totalChunks: number;
  /** Windows currently cached for this sig+sort (== totalChunks for backfill). */
  cachedChunks: number;
  /** Sections cached for this sig+sort (== totalCount for backfill). */
  cachedCount: number;
  /** Past terms are immutable snapshots — drives the dialog wording. */
  isViewOnly?: boolean;
}

export interface SearchResultsResponse {
  success: boolean;
  totalCount: number;
  data: CourseSection[];
  pageOffset: number;
  pageMaxSize: number;
  sectionsFetchedCount: number;
  pathMode: string | null;
  /** Present for page-cached (dynamic) and fully-backfilled terms alike. */
  coverage?: SearchCoverage;
}

/** One window, for the coverage grid (`/api/coverage`). */
export interface CoverageChunk {
  /** Offset-aligned window index; covers sections [index*chunkSize, +chunkSize). */
  index: number;
  /** Sections in this window (chunkSize, or fewer for the last window). */
  count: number;
  /** Page-cache mode: epoch ms the window was last fetched from Banner. */
  fetchedAt?: number;
  /** Backfill mode: oldest `synced_at` in the window (worst-case staleness). */
  oldestSyncedAt?: number;
  /** Backfill mode: newest `synced_at` in the window. */
  newestSyncedAt?: number;
}

/** Full per-window coverage for one search's sort + filters (`/api/coverage`). */
export interface CoverageDetail {
  mode: "page-cache" | "backfill";
  dynamic: boolean;
  chunkSize: number;
  totalCount: number;
  totalChunks: number;
  /**
   * Page-cache: only the cached windows (absent indices are uncached).
   * Backfill: every window (all present), carrying per-window `synced_at` age.
   */
  chunks: CoverageChunk[];
  /** Past terms are immutable snapshots — drives the dialog wording. */
  isViewOnly?: boolean;
  /** Backfill mode: term-level anchors so the two staleness axes are explicit. */
  lastSyncedAt?: number | null;
  lastSeatRefreshAt?: number | null;
}

export interface SearchParams {
  term: string;
  subject: string;
  courseNumber?: string;
  /** UH campus code (e.g. "MAN"); undefined means all campuses. */
  campus?: string;
  /** Academic college code (from the course catalog); undefined = all. */
  college?: string;
  /** Department code (from the course catalog); undefined = all. */
  department?: string;
  openOnly?: boolean;
  pageOffset: number;
  pageMaxSize: number;
  sortColumn?: string;
  sortDirection?: string;
}
