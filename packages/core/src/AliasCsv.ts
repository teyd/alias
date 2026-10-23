import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * Aliases as CSV (RFC 4180), for exports and imports (PLAN.md §20.31). The web app and the CLI
 * both write and read it here, so an exported file imports again.
 *
 * Spreadsheets run a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return as a
 * formula (CSV injection). An alias's description and labels are the owner's text, but a local
 * part created on the fly is chosen by whoever mailed it, so every such cell gets a leading `'`,
 * as OWASP recommends; reading strips it again.
 */

/** One alias in an export. */
export interface Row {
  readonly address: string;
  readonly isActive: boolean;
  readonly mode: string;
  readonly description: Option.Option<string>;
  readonly labels: ReadonlyArray<string>;
  /** Recipient addresses; empty means the default recipient. */
  readonly recipients: ReadonlyArray<string>;
  readonly forwardedCount: number;
  readonly blockedCount: number;
  readonly createdAt: DateTime.Utc;
}

/** One alias to create, as read from a file. `row` counts data rows from 1, after the header. */
export interface ImportRow {
  readonly row: number;
  readonly address: string;
  readonly description?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly isActive?: boolean;
}

/** The file isn't CSV this can read. */
export class CsvError extends Schema.TaggedError<CsvError>()("CsvError", {
  reason: Schema.Literals(["empty", "no-address-column", "unterminated-quote"]),
}) {}

const COLUMNS = [
  "address",
  "active",
  "mode",
  "description",
  "labels",
  "recipients",
  "forwarded",
  "blocked",
  "created_at",
] as const;

/** Labels and recipients share a cell; neither may contain it. */
const LIST_SEPARATOR = "; ";

const FORMULA_START = /^[=+\-@\t\r]/;
const ESCAPED_FORMULA = /^'(?=[=+\-@\t\r])/;
const NEEDS_QUOTES = /[",\r\n]/;

/** A cell, safe from spreadsheets running it and quoted where RFC 4180 says so. */
const cell = (value: string): string => {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${Str.replaceAll('"', '""')(safe)}"` : safe;
};

/** The export: a header line and one line per alias, CRLF-terminated (RFC 4180 §2). */
export const format = (rows: ReadonlyArray<Row>): string =>
  Arr.join(
    Arr.map(
      Arr.prepend(
        Arr.map(rows, (row): ReadonlyArray<string> => [
          row.address,
          String(row.isActive),
          row.mode,
          Option.getOrElse(row.description, () => ""),
          Arr.join(row.labels, LIST_SEPARATOR),
          Arr.join(row.recipients, LIST_SEPARATOR),
          String(row.forwardedCount),
          String(row.blockedCount),
          DateTime.formatIso(row.createdAt),
        ]),
        COLUMNS,
      ),
      (line) => `${Arr.join(Arr.map(line, cell), ",")}\r\n`,
    ),
    "",
  );

interface Scan {
  readonly records: ReadonlyArray<ReadonlyArray<string>>;
  readonly record: ReadonlyArray<string>;
  readonly field: string;
  /** Inside a quoted field. */
  readonly isQuoted: boolean;
  /** The last character closed a quoted field, or was a `"` that may start an escaped one. */
  readonly isAfterQuote: boolean;
}

const start: Scan = { records: [], record: [], field: "", isQuoted: false, isAfterQuote: false };

/** One character of RFC 4180, leniently: LF or CRLF ends a record, and stray quotes are kept. */
const step = (scan: Scan, char: string): Scan => {
  if (scan.isQuoted) {
    if (char !== '"') return { ...scan, field: scan.field + char };
    return { ...scan, isQuoted: false, isAfterQuote: true };
  }
  if (scan.isAfterQuote && char === '"') {
    // `""` inside a quoted field: one quote, and the field goes on.
    return { ...scan, field: `${scan.field}"`, isQuoted: true, isAfterQuote: false };
  }
  const plain = { ...scan, isAfterQuote: false };
  if (char === ",") return { ...plain, record: Arr.append(scan.record, scan.field), field: "" };
  if (char === "\n") {
    return {
      ...plain,
      records: Arr.append(scan.records, Arr.append(scan.record, scan.field)),
      record: [],
      field: "",
    };
  }
  if (char === "\r") return plain;
  if (char === '"' && Str.isEmpty(scan.field)) return { ...plain, isQuoted: true };
  return { ...plain, field: scan.field + char };
};

/** Every record of a CSV text, blank lines left out. */
const records = (text: string): Result.Result<ReadonlyArray<ReadonlyArray<string>>, CsvError> => {
  // A byte order mark from a spreadsheet's "CSV UTF-8" isn't part of the first header.
  const scan = Arr.reduce(Array.from(Str.replace(/^﻿/, "")(text)), start, step);
  if (scan.isQuoted) return Result.fail(new CsvError({ reason: "unterminated-quote" }));
  const all = Arr.append(scan.records, Arr.append(scan.record, scan.field));
  return Result.succeed(
    Arr.filter(all, (record) => !Arr.every(record, (field) => Str.isEmpty(Str.trim(field)))),
  );
};

const unescape = (value: string): string => Str.trim(Str.replace(ESCAPED_FORMULA, "")(value));

const list = (value: string): ReadonlyArray<string> =>
  Arr.filter(Arr.map(Str.split(value, ";"), Str.trim), Str.isNonEmpty);

const truths: R.ReadonlyRecord<string, boolean> = {
  true: true,
  yes: true,
  "1": true,
  false: false,
  no: false,
  "0": false,
};

/**
 * The aliases a CSV file asks for. The header names the columns, in any order and letter case;
 * only `address` is required, and `description`, `labels` (separated by `;`) and `active` are
 * read too, so an export imports again. Other columns, and an `active` value that is neither
 * true/false, yes/no nor 1/0, are ignored. Rows without an address are skipped.
 */
export const parse = (text: string): Result.Result<ReadonlyArray<ImportRow>, CsvError> =>
  Result.flatMap(records(text), (found) => {
    const header = Arr.head(found);
    if (Option.isNone(header)) return Result.fail(new CsvError({ reason: "empty" }));
    const names = Arr.map(header.value, (name) => Str.toLowerCase(unescape(name)));
    const column = (name: string) => Arr.findFirstIndex(names, (candidate) => candidate === name);
    const address = column("address");
    if (Option.isNone(address)) return Result.fail(new CsvError({ reason: "no-address-column" }));
    const read = (record: ReadonlyArray<string>, name: string) =>
      Option.map(
        Option.flatMap(column(name), (index) => Arr.get(record, index)),
        unescape,
      );
    return Result.succeed(
      Arr.filterMap(Arr.drop(found, 1), (record, index) => {
        const value = Option.getOrElse(read(record, "address"), () => "");
        if (Str.isEmpty(value)) return Result.failVoid;
        const active = Option.flatMap(read(record, "active"), (raw) =>
          R.get(truths, Str.toLowerCase(raw)),
        );
        return Result.succeed<ImportRow>({
          row: index + 1,
          address: value,
          ...R.getSomes({
            description: Option.filter(read(record, "description"), Str.isNonEmpty),
          }),
          ...Option.match(Option.map(read(record, "labels"), list), {
            onNone: () => ({}),
            onSome: (labels) => ({ labels }),
          }),
          ...Option.match(active, { onNone: () => ({}), onSome: (isActive) => ({ isActive }) }),
        });
      }),
    );
  });
