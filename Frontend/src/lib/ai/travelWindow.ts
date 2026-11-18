/**
 * A travel window is not a destination.
 *
 * Destination-discovery replies and stage answers sometimes echo the timing
 * back as the destination ("October", "Late March", "next month"). Left alone,
 * that becomes the trip's city: the header reads "October", the flight bar
 * offers "Flying to October?", and weather/geocoding queries go nowhere.
 *
 * Pure and dependency-free so both the zod schema and the trip-profile
 * stage machine can share it without pulling zod into the client bundle.
 */
const MONTH_SOURCE =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const TRAVEL_WINDOW_RE = new RegExp(
  [
    `^(?:(?:early|mid|late)\\s+)?(?:${MONTH_SOURCE})(?:\\s+\\d{4})?$`,
    `^(?:spring|summer|autumn|fall|winter)(?:\\s+\\d{4})?$`,
    `^\\d{4}$`,
    `^(?:next|this)\\s+(?:week|weekend|month|year)$`,
    `^\\d+\\s*(?:days?|weeks?|nights?)(?:\\s+(?:in|of|from)\\s+.*)?$`,
  ].join("|"),
  "i"
);

export function isTravelWindow(value: string): boolean {
  return TRAVEL_WINDOW_RE.test(value.trim());
}
