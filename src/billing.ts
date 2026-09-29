const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;

export interface ReapInput {
  readonly now: Date;
  readonly createdAt: Date;
  /** True if any runner on the server is running a job or a job is waiting for it. */
  readonly busy: boolean;
  /** Minutes into each paid hour at which the server becomes eligible for deletion. */
  readonly windowStartMinute?: number;
}

/** Minutes since creation, or 0 if the clock says it was created in the future. */
export const ageMinutes = (now: Date, createdAt: Date): number =>
  Math.max(0, (now.getTime() - createdAt.getTime()) / MINUTE_MS);

/** Where we are inside the current paid hour, in [0, 60). */
export const minuteWithinPaidHour = (now: Date, createdAt: Date): number =>
  ageMinutes(now, createdAt) % HOUR_MINUTES;

/**
 * Providers that bill per started hour charge a full extra hour the moment a
 * server passes an hour boundary. So an idle server should die shortly before
 * one, and a busy one is left alone to ride into the next paid hour.
 *
 * The window is the last (60 - windowStartMinute) minutes of each paid hour.
 * The scheduled reaper must therefore run more often than that window is wide,
 * and GitHub can delay or drop scheduled runs, so don't shrink it too far.
 */
export const shouldReap = ({
  now,
  createdAt,
  busy,
  windowStartMinute = 50,
}: ReapInput): boolean =>
  !busy && minuteWithinPaidHour(now, createdAt) >= windowStartMinute;
