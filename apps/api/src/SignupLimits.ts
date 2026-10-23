import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * How much sign-up and login one client, one account and everyone may do (PLAN.md §20.27).
 * Windows are fixed UTC hours and days (`Quota.window`); a client is its hashed address
 * (`ClientSource`).
 */
export interface Limits {
  /** Sign-up and login challenges per client and hour. */
  readonly challengesPerHour: number;
  /** Accounts per client and day. */
  readonly signupsPerDay: number;
  /** Accounts per hour for everyone together: the circuit breaker. */
  readonly signupsPerHour: number;
  /** Failed passkey assertions per account and hour; past them the account's logins wait. */
  readonly loginFailuresPerHour: number;
}

const defaults: Limits = {
  challengesPerHour: 30,
  signupsPerDay: 5,
  signupsPerHour: 100,
  loginFailuresPerHour: 10,
};

/** The limits in force; {@link defaults} unless a layer says otherwise. */
export const SignupLimits = Context.Reference<Limits>("@alias/api/SignupLimits", {
  defaultValue: () => defaults,
});

/** The defaults with some limits changed. */
export const layer = (overrides: Partial<Limits>) =>
  Layer.succeed(SignupLimits, { ...defaults, ...overrides });

/** `ALIAS_MAX_SIGNUPS_PER_HOUR` sets the circuit breaker; the other limits are the defaults. */
export const config = Config.Int("ALIAS_MAX_SIGNUPS_PER_HOUR").pipe(
  Config.withDefault(defaults.signupsPerHour),
  Config.map((signupsPerHour) => layer({ signupsPerHour })),
);
