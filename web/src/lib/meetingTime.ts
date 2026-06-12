import type { MeetingTime } from "@/lib/sis/types";

// Shared meeting-time formatters used by both the results table and the
// section-detail dialog header, so the rendering stays identical between them.

export function formatDays(mt: MeetingTime): string {
  const days = [
    mt.monday && "M",
    mt.tuesday && "T",
    mt.wednesday && "W",
    mt.thursday && "R",
    mt.friday && "F",
    mt.saturday && "Sa",
    mt.sunday && "Su",
  ].filter(Boolean);
  return days.join("") || "—";
}

export function formatTime(hhmm: string | null): string {
  if (!hhmm) return "—";
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = hhmm.slice(2);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${m} ${ampm}`;
}

export function formatMeetingTime(mt: MeetingTime): string {
  if (!mt.beginTime && !mt.endTime) return "TBA";
  return `${formatDays(mt)} ${formatTime(mt.beginTime)}–${formatTime(mt.endTime)}`;
}
