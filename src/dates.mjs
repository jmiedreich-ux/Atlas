// Milestone dates: what a stored calendar day is, and how the page prints one.
//
// #780 settled the whole shape of this. A CLOSED milestone stores both dates — when it started
// and when it closed — and both are static facts recorded when they happened. CURRENT and NEXT
// carry a start date only. FUTURE milestones carry nothing. So no figure on the page is ever
// derived from today, and the byte-identical guarantee holds unchanged: the earlier proposal, a
// days-open count on an open milestone, was the one thing that would have broken it.
//
// Nothing in this module reads the clock, and nothing in it constructs a `Date` from a string.
// `new Date('2026-08-09')` parses as UTC midnight and then prints as the 8th on any machine west
// of Greenwich, so a site built in London and a site built in Denver would disagree about a date
// that is a stored fact in both. The digits are parsed by hand and the arithmetic is done in UTC.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(value) {
  const match = ISO_DAY.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Is this a stored calendar day — `YYYY-MM-DD`, zero-padded, and a day that really exists?
 *
 * Zero-padding is required rather than merely tolerated: an unpadded `2026-8-9` sorts before
 * `2026-10-01` as a string, and these values are compared as strings everywhere else.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const day = parts(value);
  if (!day) return false;
  if (day.month < 1 || day.month > 12) return false;
  if (day.day < 1) return false;

  // Round-tripped through UTC rather than checked against a table of month lengths, so February
  // in a leap year needs no special case.
  const asUtc = Date.UTC(day.year, day.month - 1, day.day);
  const check = new Date(asUtc);
  return (
    check.getUTCFullYear() === day.year &&
    check.getUTCMonth() === day.month - 1 &&
    check.getUTCDate() === day.day
  );
}

/**
 * A stored day as the page prints it: `9 Aug 2026`.
 *
 * The year is carried. A project outlives one of them, and "9 Aug" beside "9 Aug" on two
 * different columns is a date nobody can act on.
 *
 * @param {string} value - already known to satisfy `isCalendarDate`.
 * @returns {string}
 */
export function formatDay(value) {
  const day = parts(value);
  if (!day) return '';
  return `${day.day} ${MONTHS[day.month - 1]} ${day.year}`;
}

/**
 * Whole days from one stored day to another. Both are facts on record; neither is today.
 *
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export function daysBetween(from, to) {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return 0;
  const start = Date.UTC(a.year, a.month - 1, a.day);
  const end = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((end - start) / 86400000);
}

/**
 * How long that was, in English. Zero days is "same day" rather than "0 days", which reads as a
 * missing figure rather than as a milestone that opened and closed in one sitting.
 *
 * @param {number} days
 * @returns {string}
 */
export function formatDuration(days) {
  if (days <= 0) return 'same day';
  return days === 1 ? '1 day' : `${days} days`;
}
