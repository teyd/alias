import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

/** One value of a row; nothing is JSON `null` and `-` in a table. */
type Cell = string | number | boolean | Option.Option<string>;

/** A row as both outputs show it: column → value. */
export type Row = Readonly<Record<string, Cell>>;

const cell = (value: Cell): string =>
  Option.isOption(value) ? Option.getOrElse(value, () => "-") : String(value);

const toJson = (row: Row): Schema.Json =>
  R.map(row, (value) => (Option.isOption(value) ? Option.getOrNull(value) : value));

/** Rows as aligned columns under upper-case headers, for people. */
const table = (columns: ReadonlyArray<string>, rows: ReadonlyArray<Row>): string => {
  const cells = Arr.map(rows, (row) =>
    Arr.map(columns, (column) => cell(row[column] ?? Option.none())),
  );
  const widths = Arr.map(columns, (column, index) =>
    Math.max(column.length, ...Arr.map(cells, (line) => (line[index] ?? "").length)),
  );
  const line = (values: ReadonlyArray<string>) =>
    Arr.join(
      Arr.map(values, (value, index) => value.padEnd(widths[index] ?? 0)),
      "  ",
    ).trimEnd();
  return Arr.join(
    [line(Arr.map(columns, (column) => column.toUpperCase())), ...Arr.map(cells, line)],
    "\n",
  );
};

const Json = Schema.fromJsonString(Schema.Json);

/** Prints rows for people (a table, or `empty` when there are none) or for programs (`--json`). */
export const rows = Effect.fn("Output.rows")(function* (
  isJson: boolean,
  columns: ReadonlyArray<string>,
  values: ReadonlyArray<Row>,
  empty: string,
) {
  if (isJson)
    return yield* Console.log(
      yield* Schema.encodeEffect(Json)(Arr.map(values, toJson)).pipe(Effect.orDie),
    );
  yield* Console.log(Arr.isReadonlyArrayNonEmpty(values) ? table(columns, values) : empty);
});

/** Prints one record: as JSON, or as `key: value` lines. */
export const record = Effect.fn("Output.record")(function* (isJson: boolean, value: Row) {
  if (isJson)
    return yield* Console.log(yield* Schema.encodeEffect(Json)(toJson(value)).pipe(Effect.orDie));
  yield* Console.log(
    Arr.join(
      Arr.map(R.toEntries(value), ([key, field]) => `${key}: ${cell(field)}`),
      "\n",
    ),
  );
});
