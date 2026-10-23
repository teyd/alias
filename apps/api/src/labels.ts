import {
  Api,
  CurrentUser,
  type Label,
  LabelColor,
  MAX_LABEL_COLORS,
  TooManyLabelColors,
} from "@alias/contracts";
import { AliasRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

const decodeColor = Schema.decodeUnknownOption(LabelColor);

const byName = Order.mapInput(Order.String, (label: Label) => label.name);

/**
 * The caller's labels (PLAN.md §20.31): every label on one of their aliases, and every label
 * they gave a colour, by name.
 */
const list = Effect.fn("labels.list")(function* () {
  const user = yield* CurrentUser;
  const repo = yield* AliasRepo.AliasRepo;
  const aliases = yield* Effect.orDie(repo.listByUser(user.userId));
  const colors = yield* Effect.orDie(repo.labelColors(user.userId));
  const names = Arr.dedupe(
    Arr.appendAll(
      Arr.flatMap(aliases, (alias) => alias.labels),
      Arr.map(colors, (color) => color.label),
    ),
  );
  return Arr.sort(
    Arr.map(names, (name): Label => ({
      name,
      // A colour no client knows any more shows as none.
      color: Option.flatMap(
        Arr.findFirst(colors, (color) => color.label === name),
        (found) => decodeColor(found.color),
      ),
      aliasCount: Arr.length(Arr.filter(aliases, (alias) => Arr.contains(alias.labels, name))),
    })),
    byName,
  );
});

/**
 * Gives one of the caller's labels a colour (or none). A label nobody uses yet may be coloured
 * too, up to {@link MAX_LABEL_COLORS} coloured labels (a soft cap: the count isn't atomic).
 */
const setColor = Effect.fn("labels.setColor")(function* (
  label: string,
  color: Option.Option<LabelColor>,
) {
  const user = yield* CurrentUser;
  const repo = yield* AliasRepo.AliasRepo;
  if (Option.isSome(color)) {
    const colors = yield* Effect.orDie(repo.labelColors(user.userId));
    const isNew = !Arr.some(colors, (existing) => existing.label === label);
    if (isNew && Arr.length(colors) >= MAX_LABEL_COLORS) {
      return yield* new TooManyLabelColors({ limit: MAX_LABEL_COLORS });
    }
  }
  yield* Effect.orDie(repo.setLabelColor(user.userId, label, color));
  const labels = yield* list();
  return Option.getOrElse(
    Arr.findFirst(labels, (found) => found.name === label),
    (): Label => ({ name: label, color: Option.none(), aliasCount: 0 }),
  );
});

export const LabelsLive = HttpApiBuilder.group(Api, "labels", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<AliasRepo.AliasRepo>();
    return handlers
      .handle("list", () => Effect.provide(list(), services))
      .handle("setColor", ({ params, payload }) =>
        Effect.provide(setColor(params.label, payload.color), services),
      );
  }),
);
