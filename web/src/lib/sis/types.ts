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
  beginDate: string | null;
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

export interface SearchResultsResponse {
  success: boolean;
  totalCount: number;
  data: CourseSection[];
  pageOffset: number;
  pageMaxSize: number;
  sectionsFetchedCount: number;
  pathMode: string | null;
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
