import * as Context from "effect/Context";

/** The pipeline's hard limits. Tests lower them; production runs with {@link defaults}. */
export class Limits extends Context.Service<
  Limits,
  {
    /**
     * Larger mail is dropped as `too-large` before it is read (S3 `HeadObject`), which keeps the
     * Lambda's memory bounded. Mailbox providers refuse mail far smaller than SES's 40 MB, and
     * every such bounce counts against the account's bounce rate.
     */
    readonly maxMessageBytes: number;
    /**
     * Forwards per alias and UTC hour. Past it, mail is dropped as `rate-limited`: the last line
     * of defence against a loop the other checks miss, and against floods (PLAN.md §19.2).
     */
    readonly forwardsPerHour: number;
    /**
     * Aliases created on the fly per user and UTC day (PLAN.md §19.2: rate-limit on-the-fly
     * creation). Past it, mail to new addresses is dropped as `creation-limited`; existing
     * aliases keep working.
     */
    readonly aliasesCreatedPerDay: number;
  }
>()("@alias/inbound/Limits") {}

export const defaults: Limits["Service"] = {
  maxMessageBytes: 25 * 1024 * 1024,
  forwardsPerHour: 100,
  aliasesCreatedPerDay: 20,
};
