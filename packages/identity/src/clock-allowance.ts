// The cross-clock allowance (docs/briefs/fix-signin-clock-and-stage-log.md). The sign-in and
// session paths read three clocks: the Worker's own Date.now(), the database's
// clock_timestamp() and WorkOS's timestamps. A check that compares an instant from one of them
// with another clock's instant with zero tolerance fails whenever the other clock leads the
// Worker's by more than the latency between them, which healthy clocks do. Such a check allows
// the other clock to lead by at most this much. The allowance never lengthens a lifetime: the
// database's own limits, the 1800-second cookie cap and the 12-hour family cap stay as they are.
export const CROSS_CLOCK_ALLOWANCE_MS = 5000;
