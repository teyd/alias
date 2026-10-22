import event from "@alias/aws/fixtures/ses-lambda-event.json" with { type: "json" };
import { SesEvent } from "@alias/aws";
import type { AliasRepo, RecipientRepo } from "@alias/db";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Policy from "../src/Policy.ts";
import * as ReverseKeys from "../src/ReverseKeys.ts";
import { route } from "../src/Route.ts";

const shared = ["alias.test", "alias2.test"];

/** The AWS-documented event, so the decisions run on the receipt shape production parses. */
const documented = SesEvent.decode(event).pipe(
  Effect.flatMap((decoded) => Effect.fromOption(Arr.head(decoded.Records))),
  Effect.map((record) => record.ses),
);

type Receipt = Effect.Success<typeof documented>["receipt"];
type Status = Receipt["spamVerdict"]["status"];

const receiptWith = (
  receipt: Receipt,
  verdicts: Partial<Record<"spam" | "virus" | "dkim" | "dmarc", Status>>,
): Receipt => ({
  ...receipt,
  spamVerdict: { status: verdicts.spam ?? "PASS" },
  virusVerdict: { status: verdicts.virus ?? "PASS" },
  dkimVerdict: { status: verdicts.dkim ?? "PASS" },
  dmarcVerdict: { status: verdicts.dmarc ?? "PASS" },
});

const alias: AliasRepo.Alias = {
  id: "al_1",
  userId: "usr_1",
  domain: "alias.test",
  localPart: "shop",
  mode: "forward",
  isActive: true,
  createdAt: 0,
  forwardedCount: 0,
  blockedCount: 0,
};

const recipient = (
  address: string,
  fields: { readonly isVerified?: boolean; readonly isDefault?: boolean } = {},
): RecipientRepo.Recipient => ({
  id: `rcp_${address}`,
  userId: "usr_1",
  address,
  createdAt: DateTime.makeUnsafe(0),
  verifiedAt: fields.isVerified === false ? Option.none() : Option.some(DateTime.makeUnsafe(1)),
  lastSentAt: DateTime.makeUnsafe(0),
  isDefault: fields.isDefault ?? false,
});

describe("route", () => {
  it.effect("forwards mail to aliases on shared domains and user subdomains", () =>
    Effect.gen(function* () {
      expect(yield* route("Shop@Alias.test", shared)).toMatchObject({
        _tag: "Forward",
        alias: { local: "shop", domain: "alias.test" },
      });
      expect(yield* route("news@user1.alias2.test", shared)).toMatchObject({
        _tag: "Forward",
        alias: { local: "news", domain: "user1.alias2.test" },
      });
    }),
  );

  it.effect("sends reverse aliases down the reply path, on the alias they belong to", () =>
    Effect.gen(function* () {
      expect(yield* route("shop+r.abc234@user1.alias.test", shared)).toMatchObject({
        _tag: "Reply",
        alias: { local: "shop", domain: "user1.alias.test" },
        token: "abc234",
      });
    }),
  );

  it.effect.each<readonly [string, string]>([
    ["not an address", "invalid-address"],
    ["shop@custom.example", "custom-domain"],
    ["shop@deep.user1.alias.test", "custom-domain"],
  ])("leaves %j unroutable (%s)", ([address, reason]) =>
    Effect.gen(function* () {
      expect(yield* route(address, shared)).toMatchObject({ _tag: "Unroutable", reason });
    }),
  );
});

describe("Policy.screen", () => {
  it.effect("drops viruses before spam, and spam per the alias's spam action", () =>
    Effect.gen(function* () {
      const { receipt } = yield* documented;
      const action = Policy.spamAction(alias);
      expect(action).toBe("drop");
      expect(Policy.screen(receiptWith(receipt, { virus: "FAIL", spam: "FAIL" }), action)).toEqual(
        Option.some("virus"),
      );
      expect(Policy.screen(receiptWith(receipt, { spam: "FAIL" }), action)).toEqual(
        Option.some("spam"),
      );
    }),
  );

  it.effect.each<Status>(["PASS", "GRAY", "PROCESSING_FAILED", "DISABLED"])(
    "lets undecided or passing verdicts (%s) through",
    (status) =>
      Effect.gen(function* () {
        const { receipt } = yield* documented;
        expect(
          Policy.screen(receiptWith(receipt, { spam: status, virus: status }), "drop"),
        ).toEqual(Option.none());
      }),
  );
});

describe("Policy.forwardTarget", () => {
  it("picks the default recipient", () => {
    const target = recipient("b@mail.example", { isDefault: true });
    expect(Policy.forwardTarget([recipient("a@mail.example"), target])).toEqual(
      Option.some(target),
    );
  });

  it("finds none without a verified default", () => {
    expect(Policy.forwardTarget([])).toEqual(Option.none());
    expect(
      Policy.forwardTarget([recipient("a@mail.example", { isVerified: false, isDefault: true })]),
    ).toEqual(Option.none());
  });
});

describe("Policy.sender", () => {
  it.effect("reads the documented From header", () =>
    Effect.gen(function* () {
      const { mail } = yield* documented;
      expect(Policy.sender(mail)).toEqual(
        Option.some({ name: Option.some("Doe, John"), address: "sender@example.com" }),
      );
    }),
  );

  it.effect("falls back to the envelope sender, and finds none for a null sender", () =>
    Effect.gen(function* () {
      const { mail } = yield* documented;
      const { from: _, ...headers } = mail.commonHeaders;
      expect(Policy.sender({ ...mail, commonHeaders: headers })).toEqual(
        Option.some({ name: Option.none(), address: "prvs=144d0cba7=sender@example.com" }),
      );
      expect(Policy.sender({ ...mail, commonHeaders: headers, source: "" })).toEqual(Option.none());
    }),
  );
});

describe("Policy.rejectReply", () => {
  const owner = [
    recipient("ada@mail.example"),
    recipient("pending@mail.example", { isVerified: false }),
  ];

  it.effect("accepts an authenticated reply from a verified recipient, in any letter case", () =>
    Effect.gen(function* () {
      const { receipt } = yield* documented;
      expect(
        Policy.rejectReply(receiptWith(receipt, {}), Option.some("Ada@Mail.example"), owner),
      ).toEqual(Option.none());
    }),
  );

  it.effect.each<readonly [Status, Status]>([
    ["FAIL", "PASS"],
    ["PASS", "FAIL"],
    ["PASS", "GRAY"],
    ["GRAY", "PASS"],
  ])("rejects a reply unless DKIM and DMARC pass (dkim %s, dmarc %s)", ([dkim, dmarc]) =>
    Effect.gen(function* () {
      const { receipt } = yield* documented;
      expect(
        Policy.rejectReply(
          receiptWith(receipt, { dkim, dmarc }),
          Option.some("ada@mail.example"),
          owner,
        ),
      ).toEqual(Option.some("unauthenticated-reply"));
    }),
  );

  it.effect("rejects a reply from anyone but a verified recipient of the owner", () =>
    Effect.gen(function* () {
      const receipt = receiptWith((yield* documented).receipt, {});
      expect(Policy.rejectReply(receipt, Option.some("mallory@evil.example"), owner)).toEqual(
        Option.some("foreign-reply-sender"),
      );
      expect(Policy.rejectReply(receipt, Option.some("pending@mail.example"), owner)).toEqual(
        Option.some("foreign-reply-sender"),
      );
      expect(Policy.rejectReply(receipt, Option.none(), owner)).toEqual(
        Option.some("foreign-reply-sender"),
      );
    }),
  );
});

describe("ReverseKeys.parse", () => {
  const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

  it.effect("mints with the first key and keeps the others for verifying", () =>
    Effect.gen(function* () {
      const keys = yield* ReverseKeys.parse(Redacted.make(` 2:${secret(2)}, 1:${secret(1)} `));
      expect(keys.current.version).toBe(2);
      expect(keys.retired.map((key) => key.version)).toEqual([1]);
      expect(Redacted.value(keys.current.secret)).toEqual(new Uint8Array(32).fill(2));
    }),
  );

  it.effect.each<readonly [string, string]>([
    ["", "no key given"],
    [`one:${secret(1)}`, "entry 1: expected <version>:<base64url secret>"],
    [`1:${secret(1)},2:not+base64`, "entry 2: expected <version>:<base64url secret>"],
    ["1:c2hvcnQ", "secrets need at least 32 bytes"],
    [`1:${secret(1)},1:${secret(2)}`, "key versions must be distinct"],
  ])("rejects %j without echoing a secret", ([value, reason]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(ReverseKeys.parse(Redacted.make(value)));
      expect(error.reason).toBe(reason);
    }),
  );
});
