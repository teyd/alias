import {
  type AliasChanges,
  AliasNotFound,
  AliasTaken,
  type AliasView,
  type ImportFailure,
  type ImportResult,
  type ImportRow,
  InvalidAlias,
  InvalidAliasRecipient,
  type LabelColor,
  MAX_IMPORT_ROWS,
  TooManyLabelColors,
} from "@alias/contracts";
import { AliasCsv } from "@alias/core";
import { queryOptions } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type Client, callApi } from "./api";

/** Why an alias change failed, worded for the person at the keyboard. */
class AliasFailed extends Schema.TaggedError<AliasFailed>()("AliasFailed", {
  message: Schema.String,
}) {}

const aliasProblems = {
  "invalid-address": "That isn't a valid address.",
  "unknown-domain": "Aliases can only live on the domains listed here.",
  "not-your-subdomain": "You can only pick addresses on your own subdomain.",
  "domain-not-verified": "That domain isn't verified. Check its DNS records first.",
  "random-only-on-shared-domain": "Shared domains only get random addresses.",
  "reserved-local-part": "Addresses can't contain “+r.”, replies use it.",
  "role-address": "Role addresses like abuse@ and postmaster@ belong to the service.",
} as const;

const describe = <E>(error: E): string => {
  if (error instanceof InvalidAlias) return aliasProblems[error.reason];
  if (error instanceof AliasTaken) return `${error.address} is already taken.`;
  if (error instanceof AliasNotFound) return "That alias no longer exists.";
  if (error instanceof InvalidAliasRecipient) {
    return error.reason === "unverified"
      ? "Confirm that destination before forwarding to it."
      : "That destination no longer exists.";
  }
  if (error instanceof TooManyLabelColors) {
    return `Only ${error.limit} labels can have a colour. Take one away first.`;
  }
  return "Something went wrong. Please try again.";
};

const explain = <A, E>(call: (api: Client) => Effect.Effect<A, E>) =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new AliasFailed({ message: describe(error) })),
  );

export const aliasesQuery = queryOptions({
  queryKey: ["aliases"],
  queryFn: () => callApi((api) => api.aliases.list()),
});

/** The caller's labels with their colours and how many aliases carry each. */
export const labelsQuery = queryOptions({
  queryKey: ["aliases", "labels"],
  queryFn: () => callApi((api) => api.labels.list()),
});

export const domainsQuery = queryOptions({
  queryKey: ["aliases", "domains"],
  queryFn: () => callApi((api) => api.aliases.domains()),
  staleTime: Infinity,
});

/** A random address on a shared domain, or `local` on one of the caller's subdomains. */
/** What an alias does with mail: forward it, keep it in an inbox (encrypted), or both. */
export type Delivery = AliasView["mode"];

export const createAlias = (input: {
  readonly domain: string;
  readonly local: string;
  readonly mode: Delivery;
}) =>
  explain((api) =>
    Str.isEmpty(input.local)
      ? api.aliases.create({ payload: { _tag: "Random", domain: input.domain, mode: input.mode } })
      : api.aliases.create({
          payload: { _tag: "Address", address: `${input.local}@${input.domain}`, mode: input.mode },
        }),
  );

/** Path parameters for an alias address; local parts never contain `@`. */
export const aliasParams = (address: string) => {
  const at = address.lastIndexOf("@");
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
};

/** An inactive alias keeps its address, but its mail is refused (and counted as blocked). */
export const setActive = (address: string, isActive: boolean) =>
  explain((api) => api.aliases.update({ params: aliasParams(address), payload: { isActive } }));

export const deleteAlias = (address: string) =>
  explain((api) => api.aliases.remove({ params: aliasParams(address) }));

/** Changes only the given details of an alias (PLAN.md §20.31). */
export const updateAlias = (address: string, changes: AliasChanges) =>
  explain((api) => api.aliases.update({ params: aliasParams(address), payload: changes }));

/** Gives a label a colour, or (none) takes it away. */
export const setLabelColor = (label: string, color: Option.Option<LabelColor>) =>
  explain((api) => api.labels.setColor({ params: { label }, payload: { color } }));

/** Every alias as CSV, the same file the CLI writes (`AliasCsv` in `@alias/core`). */
export const exportCsv = () =>
  callApi((api) => api.aliases.export()).then((exported) => AliasCsv.format(exported.aliases));

/** Why a row wasn't imported, worded for the person at the keyboard. */
export const importProblems: Record<ImportFailure, string> = {
  ...aliasProblems,
  taken: "That address is already taken.",
  duplicate: "That address came up earlier in the file.",
  "invalid-description": "The description is longer than 200 characters.",
  "invalid-labels":
    "A label is 1–32 letters, digits, spaces, “.”, “_” or “-”, at most 10 per alias.",
};

/** Why a file couldn't be read at all. */
export const csvProblems: Record<AliasCsv.CsvError["reason"], string> = {
  empty: "That file is empty.",
  "no-address-column": "That file has no “address” column.",
  "unterminated-quote": "That file has a quote that is never closed.",
};

/**
 * Creates the rows' aliases, in requests of at most {@link MAX_IMPORT_ROWS}; each result names
 * the row of the file it came from.
 */
export const importAliases = (rows: ReadonlyArray<AliasCsv.ImportRow>) =>
  callApi((api) =>
    Effect.map(
      Effect.forEach(
        Arr.chunksOf(rows, MAX_IMPORT_ROWS),
        (chunk) =>
          Effect.map(
            api.aliases.import({
              payload: {
                aliases: Arr.map(chunk, ({ row: _row, ...fields }): ImportRow => fields),
              },
            }),
            ({ results }) =>
              Arr.map(results, (result): ImportResult => ({
                ...result,
                row: Option.getOrElse(
                  Option.map(Arr.get(chunk, result.row - 1), (found) => found.row),
                  () => result.row,
                ),
              })),
          ),
        { concurrency: 1 },
      ),
      Arr.flatten,
    ),
  );
