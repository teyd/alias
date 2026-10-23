#!/usr/bin/env node
/**
 * The operator's invite codes for the private beta (PLAN.md §20.36), straight on the table: there
 * is no admin API. The table is the Lambda's (`ALIAS_TABLE_NAME`, AWS credentials from the
 * environment); `AWS_ENDPOINT_URL_DYNAMODB` points it at an emulator, e.g. for `pnpm dev`:
 *
 *   ALIAS_TABLE_NAME=alias AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:$ALIAS_FAKECLOUD_PORT \
 *     pnpm --filter @alias/api invites mint --count 3 --note "friends"
 *
 * `mint` prints the codes; only their hashes are stored, so that is the one time they can be
 * read. `list` shows what is outstanding (by hash prefix and note); `revoke <code>` deletes one.
 */
import { InviteRepo, Dynamo } from "@alias/db";
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";
import * as Invites from "../src/Invites.ts";

const positive = (name: string, fallback: number) =>
  Flag.Int(name).pipe(
    Flag.withDefault(fallback),
    Flag.filter(
      (value) => value >= 1,
      () => `--${name} must be at least 1`,
    ),
  );

const mint = Command.make(
  "mint",
  {
    count: positive("count", 1).pipe(Flag.withDescription("How many codes to mint")),
    uses: positive("uses", 1).pipe(Flag.withDescription("Sign-ups each code allows")),
    days: positive("days", 14).pipe(Flag.withDescription("Days until the codes expire")),
    note: Flag.String("note").pipe(
      Flag.withDescription("Your own note (a batch, a channel); no names of people"),
      Flag.optional,
    ),
  },
  Effect.fn("invites.mint")(function* ({ count, uses, days, note }) {
    const codes = yield* Invites.mint({
      count,
      maxUses: uses,
      validFor: Duration.days(days),
      note,
    });
    yield* Effect.forEach(codes, (code) => Console.log(code), { concurrency: 1, discard: true });
  }),
).pipe(Command.withDescription("Mint invite codes and print them (shown only this once)"));

const list = Command.make(
  "list",
  {},
  Effect.fn("invites.list")(function* () {
    const invites = yield* (yield* InviteRepo.InviteRepo).list();
    const now = yield* DateTime.now;
    yield* Effect.forEach(
      invites,
      (invite) =>
        Console.log(
          Arr.join(
            [
              invite.hash.slice(0, 12),
              `${invite.uses}/${invite.maxUses}`,
              DateTime.isGreaterThan(invite.expiresAt, now)
                ? `until ${DateTime.formatIso(invite.expiresAt)}`
                : "expired",
              Option.getOrElse(invite.note, () => ""),
            ],
            "\t",
          ),
        ),
      { concurrency: 1, discard: true },
    );
  }),
).pipe(Command.withDescription("List invite codes: hash prefix, uses, expiry, note"));

const revoke = Command.make(
  "revoke",
  { code: Argument.String("code").pipe(Argument.withDescription("The code as handed out")) },
  Effect.fn("invites.revoke")(function* ({ code }) {
    const isRevoked = yield* Invites.revoke(code);
    yield* Console.log(isRevoked ? "revoked" : "no such invite code");
  }),
).pipe(Command.withDescription("Delete an invite code so it can't be redeemed"));

const invites = Command.make("invites").pipe(
  Command.withDescription("Invite codes for sign-up during the private beta (PLAN.md §20.36)"),
  Command.withSubcommands([mint, list, revoke]),
);

const database = Layer.unwrap(
  Effect.gen(function* () {
    return yield* Dynamo.config;
  }),
);

invites.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(
    Layer.mergeAll(
      InviteRepo.layer.pipe(Layer.provide(database)),
      NodeCrypto.layer,
      NodeServices.layer,
    ),
  ),
  NodeRuntime.runMain,
);
