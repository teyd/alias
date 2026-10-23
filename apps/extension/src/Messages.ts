import * as Schema from "effect/Schema";

/**
 * What the popup asks the background, and what it answers (PLAN.md §20.35). Both sides decode
 * with these schemas, so nothing but these shapes crosses `runtime.sendMessage`. Only the
 * extension's own pages send them: there are no content scripts and no `externally_connectable`,
 * and the background checks the sender too (`background.ts`).
 */

/** Which alias to create: a random one on a shared domain, or one named after the open site. */
export const AliasKind = Schema.Literals(["random", "site"]);
export type AliasKind = typeof AliasKind.Type;

export const Request = Schema.TaggedUnion({
  GetStatus: {},
  /** `server` is an origin the user typed; the popup has asked for its host permission. */
  SignIn: { server: Schema.String },
  SignOut: {},
  /** Creates an alias for the tab's site (or a random one) and fills it in. */
  CreateAlias: { kind: AliasKind, tabId: Schema.Int },
  ListRecent: {},
  Fill: { tabId: Schema.Int, address: Schema.String },
});
export type Request = typeof Request.Type;

export const Status = Schema.TaggedUnion({
  SignedOut: {
    /** The server last signed in to, or the build's default. */
    server: Schema.OptionFromOptionalKey(Schema.String),
  },
  SignedIn: {
    server: Schema.String,
    username: Schema.String,
    /** Where "alias for this site" goes (`ada.alias.example`), if the account has one. */
    subdomain: Schema.OptionFromOptionalKey(Schema.String),
  },
});
export type Status = typeof Status.Type;

/** What the background answers besides a status. */
export const Answer = Schema.TaggedUnion({
  Created: {
    address: Schema.String,
    /** False when the site's alias already existed and is handed out again. */
    isNew: Schema.Boolean,
    isFilled: Schema.Boolean,
  },
  Recent: {
    aliases: Schema.Array(Schema.Struct({ address: Schema.String, isActive: Schema.Boolean })),
  },
  Filled: { isFilled: Schema.Boolean },
  /** Anything that went wrong, worded for the person. */
  Failed: { message: Schema.String },
});
export type Answer = typeof Answer.Type;

export const Response = Schema.Union([Status, Answer]);
export type Response = typeof Response.Type;
