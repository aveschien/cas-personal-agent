export const businessTimeZone = "Asia/Shanghai";
export const businessUtcOffset = "+08:00";

const businessOffsetMilliseconds = 8 * 60 * 60 * 1_000;
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function formatBusinessLocalDateTime(isoTimestamp: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(isoTimestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function normalizeBusinessTimestamp(
  value: string,
  label: string,
): string {
  if (!isoTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO 8601 timestamp with timezone`);
  }
  const localIso = new Date(
    Date.parse(value) + businessOffsetMilliseconds,
  ).toISOString();
  return `${localIso.replace(/\.000Z$/, "").replace(/Z$/, "")}${businessUtcOffset}`;
}
