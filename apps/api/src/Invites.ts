import { InviteCode } from "@alias/core";
import { InviteRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { hashToken } from "./Secrets.ts";

/**
 * Who may sign up (PLAN.md §20.36): anyone who passes the human check (`open`), or only with an
 * invite code as well (`invite`, the private beta). Turnstile and the limits apply either way.
 */
export type SignupMode = "open" | "invite";

/** The mode in force; `invite` unless a layer says otherwise, so a missing setting stays closed. */
export const SignupMode = Context.Reference<SignupMode>("@alias/api/SignupMode", {
  defaultValue: () => "invite",
});

export const layer = (mode: SignupMode) => Layer.succeed(SignupMode, mode);

/** `ALIAS_SIGNUP_MODE`: `open` or `invite` (the default). Anything else fails the cold start. */
export const config = Config.Literals(["open", "invite"], "ALIAS_SIGNUP_MODE").pipe(
  Config.withDefault<SignupMode>("invite"),
  Config.map(layer),
);

/** What the table stores for a normalized code: its SHA-256, like every other bearer secret. */
export const hashCode = Effect.fn("Invites.hashCode")(function* (code: string) {
  return yield* Effect.orDie(hashToken(yield* Crypto.Crypto, code));
});

/** A fresh code, drawn again in the (below 10⁻¹³) case that too many random bytes were skipped. */
const drawCode = Effect.fn("Invites.drawCode")(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomBytes(InviteCode.RANDOM_BYTES).pipe(
    Effect.flatMap((bytes) => Effect.fromOption(InviteCode.fromBytes(bytes))),
    Effect.retry({ times: 3 }),
    Effect.orDie,
  );
});

/**
 * Mints `count` invite codes, each good for `maxUses` sign-ups within `validFor`, and returns
 * them as handed out (`BCDF-GHJK-…`). Only their hashes are stored, so this is the one time they
 * can be read.
 */
export const mint = Effect.fn("Invites.mint")(function* (options: {
  readonly count: number;
  readonly maxUses: number;
  readonly validFor: Duration.Duration;
  readonly note: Option.Option<string>;
}) {
  const invites = yield* InviteRepo.InviteRepo;
  const now = yield* DateTime.now;
  const expiresAt = DateTime.addDuration(now, options.validFor);
  return yield* Effect.forEach(
    Arr.range(1, options.count),
    () =>
      Effect.gen(function* () {
        const code = yield* drawCode();
        yield* invites.create({
          hash: yield* hashCode(code),
          note: options.note,
          maxUses: options.maxUses,
          createdAt: now,
          expiresAt,
        });
        return InviteCode.format(code);
      }),
    { concurrency: 1 },
  );
});

/** Deletes the invite with this code, as typed; false when there is none (or it isn't a code). */
export const revoke = Effect.fn("Invites.revoke")(function* (typed: string) {
  const invites = yield* InviteRepo.InviteRepo;
  return yield* Option.match(InviteCode.normalize(typed), {
    onNone: () => Effect.succeed(false),
    onSome: (code) => Effect.flatMap(hashCode(code), invites.revoke),
  });
});
