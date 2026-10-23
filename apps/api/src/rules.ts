import {
  Api,
  BlocklistEntryNotFound,
  BlocklistFull,
  CurrentUser,
  InvalidBlocklistEntry,
  InvalidRuleOrder,
  RuleNotFound,
  type RuleTestResult,
  TooManyRules,
  UnknownRecipient,
} from "@alias/contracts";
import { Blocklist, Rules } from "@alias/core";
import { FilterRepo, RecipientRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { HttpApiBuilder } from "effect/http-api";

/** The caller's blocklist, sorted. */
export const listBlocked = Effect.fn("blocklist.list")(function* () {
  const user = yield* CurrentUser;
  const filters = yield* Effect.orDie((yield* FilterRepo.FilterRepo).find(user.userId));
  return Arr.map(filters.blocklist, Blocklist.entry);
});

/** Blocks a sender address or domain on every alias of the caller. */
export const block = Effect.fn("blocklist.add")(function* (entry: Blocklist.NewEntry) {
  const user = yield* CurrentUser;
  const normalized = Blocklist.normalize(entry);
  if (Result.isFailure(normalized)) {
    return yield* new InvalidBlocklistEntry({ reason: normalized.failure });
  }
  yield* (yield* FilterRepo.FilterRepo)
    .block(user.userId, normalized.success, Blocklist.MAX_ENTRIES)
    .pipe(
      Effect.catchTags({
        BlocklistFull: ({ limit }) => Effect.fail(new BlocklistFull({ limit })),
        DatabaseError: Effect.die,
      }),
    );
  return Blocklist.entry(normalized.success);
});

export const unblock = Effect.fn("blocklist.remove")(function* (entryId: string) {
  const user = yield* CurrentUser;
  const id = Str.toLowerCase(Str.trim(entryId));
  yield* (yield* FilterRepo.FilterRepo).unblock(user.userId, id).pipe(
    Effect.catchTags({
      NoSuchEntry: () => Effect.fail(new BlocklistEntryNotFound({ entryId: id })),
      DatabaseError: Effect.die,
    }),
  );
});

/** Every `forward-to` must name one of the caller's destinations (verified or not yet). */
const checkRecipients = Effect.fn("rules.checkRecipients")(function* (rule: Rules.RuleInput) {
  const user = yield* CurrentUser;
  const named = Arr.flatMap(rule.actions, (action) =>
    action.type === "forward-to" ? [action.recipientId] : [],
  );
  if (!Arr.isArrayNonEmpty(named)) return;
  const owned = Arr.map(
    yield* Effect.orDie((yield* RecipientRepo.RecipientRepo).list(user.userId)),
    (recipient) => recipient.id,
  );
  const unknown = Arr.findFirst(named, (recipientId) => !Arr.contains(owned, recipientId));
  if (Option.isSome(unknown)) return yield* new UnknownRecipient({ recipientId: unknown.value });
});

const listRules = Effect.fn("rules.list")(function* () {
  const user = yield* CurrentUser;
  return (yield* Effect.orDie((yield* FilterRepo.FilterRepo).find(user.userId))).rules;
});

/** Changes the caller's rules; database failures are defects, refusals typed. */
const changeRules = <E>(
  change: (rules: ReadonlyArray<Rules.Rule>) => Result.Result<ReadonlyArray<Rules.Rule>, E>,
) =>
  Effect.flatMap(
    Effect.all([CurrentUser, FilterRepo.FilterRepo], { concurrency: 1 }),
    ([user, filters]) =>
      filters
        .updateRules(user.userId, change)
        .pipe(Effect.catchTag("DatabaseError", (error) => Effect.die(error))),
  );

const createRule = Effect.fn("rules.create")(function* (input: Rules.RuleInput) {
  yield* checkRecipients(input);
  const ulid = yield* Effect.orDie((yield* Crypto.Crypto).randomULID);
  const rule: Rules.Rule = { id: `rl_${ulid.toLowerCase()}`, ...input };
  yield* changeRules((rules) =>
    rules.length >= Rules.MAX_RULES
      ? Result.fail(new TooManyRules({ limit: Rules.MAX_RULES }))
      : Result.succeed(Arr.append(rules, rule)),
  );
  return rule;
});

const updateRule = Effect.fn("rules.update")(function* (ruleId: string, input: Rules.RuleInput) {
  yield* checkRecipients(input);
  const rule: Rules.Rule = { id: ruleId, ...input };
  yield* changeRules((rules) =>
    Arr.some(rules, (stored) => stored.id === ruleId)
      ? Result.succeed(Arr.map(rules, (stored) => (stored.id === ruleId ? rule : stored)))
      : Result.fail(new RuleNotFound({ ruleId })),
  );
  return rule;
});

const removeRule = (ruleId: string) =>
  Effect.asVoid(
    changeRules((rules) =>
      Arr.some(rules, (stored) => stored.id === ruleId)
        ? Result.succeed(Arr.filter(rules, (stored) => stored.id !== ruleId))
        : Result.fail(new RuleNotFound({ ruleId })),
    ),
  );

/** The rules in the order of `ruleIds`, which must name each of them once. */
const reorder = (ruleIds: ReadonlyArray<string>) =>
  changeRules((rules) => {
    const ordered = Arr.filterMap(ruleIds, (ruleId) =>
      Result.fromOption(
        Arr.findFirst(rules, (rule) => rule.id === ruleId),
        () => undefined,
      ),
    );
    return ordered.length === rules.length &&
      ruleIds.length === rules.length &&
      Arr.dedupe(ruleIds).length === ruleIds.length
      ? Result.succeed(ordered)
      : Result.fail(new InvalidRuleOrder());
  });

/** What `rules` and `blocklist` would do with `sample`; nothing is sent or stored. */
const test = Effect.fn("rules.test")(function* (payload: {
  readonly sample: Omit<Rules.Message, "labels"> & { readonly labels?: ReadonlyArray<string> };
  readonly rule?: Rules.RuleInput;
}) {
  const user = yield* CurrentUser;
  const sample: Rules.Message = { ...payload.sample, labels: payload.sample.labels ?? [] };
  const saved = yield* Effect.orDie((yield* FilterRepo.FilterRepo).find(user.userId));
  const draft = Option.fromUndefinedOr(payload.rule);
  const rules = Option.match(draft, {
    onNone: () => saved.rules,
    onSome: (rule) => [{ id: "draft", ...rule }],
  });
  const listed = Option.isSome(draft)
    ? Option.none()
    : Option.flatMap(sample.sender, (sender) =>
        Blocklist.match(HashSet.fromIterable(saved.blocklist), sender),
      );
  const outcome = Rules.evaluate(Option.isSome(listed) ? [] : rules, sample);
  const result: RuleTestResult = {
    blockedBy: Option.match(listed, {
      onSome: (entryId) => Option.some({ kind: "blocklist" as const, entryId }),
      onNone: () => Option.map(outcome.blockedBy, (ruleId) => ({ kind: "rule" as const, ruleId })),
    }),
    matched: outcome.matched,
    subject: Option.map(outcome.subject, (change) =>
      Rules.changeSubject(
        change,
        Option.getOrElse(sample.subject, () => ""),
      ),
    ),
    displayName: outcome.displayName,
    recipientId: outcome.recipientId,
    isTrackerRemovalSkipped: outcome.isTrackerRemovalSkipped,
    isEncryptionSkipped: outcome.isEncryptionSkipped,
    notify: outcome.notify,
  };
  return result;
});

export const BlocklistLive = HttpApiBuilder.group(Api, "blocklist", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<FilterRepo.FilterRepo>();
    return handlers
      .handle("list", () => Effect.provide(listBlocked(), services))
      .handle("add", ({ payload }) => Effect.provide(block(payload), services))
      .handle("remove", ({ params }) => Effect.provide(unblock(params.entryId), services));
  }),
);

export const RulesLive = HttpApiBuilder.group(Api, "rules", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      FilterRepo.FilterRepo | RecipientRepo.RecipientRepo | Crypto.Crypto
    >();
    return handlers
      .handle("list", () => Effect.provide(listRules(), services))
      .handle("create", ({ payload }) => Effect.provide(createRule(payload), services))
      .handle("update", ({ params, payload }) =>
        Effect.provide(updateRule(params.ruleId, payload), services),
      )
      .handle("remove", ({ params }) => Effect.provide(removeRule(params.ruleId), services))
      .handle("reorder", ({ payload }) => Effect.provide(reorder(payload.ruleIds), services))
      .handle("test", ({ payload }) => Effect.provide(test(payload), services));
  }),
);
