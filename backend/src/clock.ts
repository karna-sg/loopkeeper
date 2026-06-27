/** Calendar date (YYYY-MM-DD) that `nowIso` falls on in the given IANA timezone. */
export function todayInTz(nowIso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowIso));
}

/** ISO instant `days` before `nowIso`. */
export function daysBefore(nowIso: string, days: number): string {
  return new Date(new Date(nowIso).getTime() - days * 86_400_000).toISOString();
}
