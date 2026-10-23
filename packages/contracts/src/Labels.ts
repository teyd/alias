import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { requires } from "./Scopes.ts";

/**
 * The colours a label may have (PLAN.md §20.31): names, not CSS, so every client draws them from
 * its own palette and nothing a user types reaches a style.
 */
export const LabelColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
]);
export type LabelColor = typeof LabelColor.Type;

/**
 * One of the owner's labels: up to 32 letters, digits, spaces, `.`, `_` or `-`, starting with a
 * letter or digit. No commas or semicolons, so a list of labels is one unambiguous CSV cell.
 */
export const AliasLabel = Schema.Trim.check(
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u, {
    message: "a label is 1–32 letters, digits, spaces, '.', '_' or '-'",
  }),
);
export type AliasLabel = typeof AliasLabel.Type;

/** A label of the caller's: on at least one alias, or given a colour. */
const Label = Schema.Struct({
  name: Schema.String,
  color: Schema.OptionFromOptionalKey(LabelColor),
  /** How many of the caller's aliases carry it. */
  aliasCount: Schema.Int,
});
export type Label = typeof Label.Type;

/** The caller has given as many labels a colour as they may. */
export class TooManyLabelColors extends Schema.TaggedError<TooManyLabelColors>()(
  "TooManyLabelColors",
  { limit: Schema.Int },
  { httpApiStatus: 409 },
) {}

/** Most labels one user may give a colour. */
export const MAX_LABEL_COLORS = 50;

/**
 * Labels are tags on aliases (set with `PATCH /v1/aliases/:domain/:local { labels }`); this
 * group lists them and colours them. Renaming or removing a label means changing its aliases.
 */
export const LabelsGroup = HttpApiGroup.make("labels")
  .add(
    requires("aliases:read")(
      HttpApiEndpoint.get("list", "/labels", { success: Schema.Array(Label) }),
    ),
  )
  .add(
    requires("aliases:write")(
      HttpApiEndpoint.put("setColor", "/labels/:label", {
        params: { label: AliasLabel },
        payload: Schema.Struct({ color: Schema.OptionFromNullOr(LabelColor) }),
        success: Label,
        error: TooManyLabelColors,
      }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");
