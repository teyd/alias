import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AliasCsv } from "../src/index.ts";

const row = (overrides: Partial<AliasCsv.Row> = {}): AliasCsv.Row => ({
  address: "shop@ada.alias.test",
  isActive: true,
  mode: "forward",
  description: Option.none(),
  labels: [],
  recipients: [],
  forwardedCount: 0,
  blockedCount: 0,
  createdAt: DateTime.makeUnsafe("2026-10-23T08:30:00Z"),
  ...overrides,
});

/** The rows, or the reason the file was refused. */
const parsed = (text: string) =>
  Result.match(AliasCsv.parse(text), {
    onSuccess: (rows): ReadonlyArray<AliasCsv.ImportRow> | string => rows,
    onFailure: (error) => error.reason,
  });

describe("AliasCsv.format", () => {
  it("writes a header and one CRLF line per alias", () => {
    expect(
      AliasCsv.format([
        row({
          description: Option.some("Online shop"),
          labels: ["shopping", "eu"],
          recipients: ["me@mailbox.test", "work@mailbox.test"],
          forwardedCount: 12,
          blockedCount: 3,
          isActive: false,
        }),
      ]),
    ).toBe(
      "address,active,mode,description,labels,recipients,forwarded,blocked,created_at\r\n" +
        "shop@ada.alias.test,false,forward,Online shop,shopping; eu," +
        "me@mailbox.test; work@mailbox.test,12,3,2026-10-23T08:30:00.000Z\r\n",
    );
  });

  it("quotes commas, quotes and line breaks (RFC 4180)", () => {
    const text = AliasCsv.format([row({ description: Option.some('Say "hi",\nthen go') })]);
    expect(text).toContain(',"Say ""hi"",\nthen go",');
  });

  it("defuses every cell a spreadsheet would run as a formula", () => {
    const text = AliasCsv.format([
      row({
        address: "-2+3@ada.alias.test",
        description: Option.some('=HYPERLINK("http://evil.test","x")'),
        labels: ["@SUM(A1)", "+1"],
      }),
      row({ description: Option.some("\tcmd") }),
      row({ description: Option.some("\rcmd") }),
    ]);
    const lines = text.split("\r\n");
    expect(lines[1]).toBe(
      '\'-2+3@ada.alias.test,true,forward,"\'=HYPERLINK(""http://evil.test"",""x"")",' +
        "'@SUM(A1); +1,,0,0,2026-10-23T08:30:00.000Z",
    );
    expect(lines[2]).toContain(",'\tcmd,");
    // A carriage return needs quotes as well as the prefix.
    expect(text).toContain(',"\'\rcmd",');
  });
});

describe("AliasCsv.parse", () => {
  it("reads an export back: address, description, labels and active", () => {
    const text = AliasCsv.format([
      row({
        address: "-news@ada.alias.test",
        description: Option.some('=1+1, "quoted"\nand more'),
        labels: ["a", "b c"],
        isActive: false,
      }),
      row({ address: "plain@ada.alias.test" }),
    ]);
    expect(parsed(text)).toEqual([
      {
        row: 1,
        address: "-news@ada.alias.test",
        description: '=1+1, "quoted"\nand more',
        labels: ["a", "b c"],
        isActive: false,
      },
      { row: 2, address: "plain@ada.alias.test", labels: [], isActive: true },
    ]);
  });

  it("takes columns in any order and letter case, ignores the rest, and skips blank lines", () => {
    const text =
      "﻿Notes,Labels,ADDRESS\n" +
      "x,work;  home ;,a@ada.alias.test\n" +
      "\n" +
      ",,\n" +
      "y,,b@ada.alias.test";
    expect(parsed(text)).toEqual([
      { row: 1, address: "a@ada.alias.test", labels: ["work", "home"] },
      { row: 2, address: "b@ada.alias.test", labels: [] },
    ]);
  });

  it("reads yes/no and 1/0, and ignores other active values", () => {
    expect(parsed("address,active\na@x.test,YES\nb@x.test,0\nc@x.test,maybe\n")).toEqual([
      { row: 1, address: "a@x.test", isActive: true },
      { row: 2, address: "b@x.test", isActive: false },
      { row: 3, address: "c@x.test" },
    ]);
  });

  it("skips rows without an address but keeps counting them", () => {
    expect(parsed("address,description\n,lost\nb@x.test,kept\n")).toEqual([
      { row: 2, address: "b@x.test", description: "kept" },
    ]);
  });

  it("refuses an empty file, one without an address column, and an open quote", () => {
    const reason = (text: string) =>
      Result.match(AliasCsv.parse(text), {
        onSuccess: () => "parsed",
        onFailure: (error) => error.reason,
      });
    expect(reason("")).toBe("empty");
    expect(reason("\r\n\r\n")).toBe("empty");
    expect(reason("email,labels\na@x.test,\n")).toBe("no-address-column");
    expect(reason('address\n"a@x.test\n')).toBe("unterminated-quote");
  });
});
