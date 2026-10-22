import { AwsClient, Objects } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { AliasRepo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Inbox } from "../src/index.ts";
import { TestInbox, freshInbox } from "./support/index.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const otpMail = bytes(
  [
    "From: Example Login <no-reply@login.example>",
    "To: k7m2qx9pzr@tmp.test",
    "Subject: 482913 is your sign-in code",
    "Date: Thu, 22 Oct 2026 09:41:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your verification code is 482913.",
    "--b",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p onclick="x()">Your verification code is <b>482913</b>.</p><img src="https://track.example/p.gif">' +
      '<a href="https://login.example/verify?token=abc">Verify</a><script>alert(1)</script>',
    "--b--",
    "",
  ].join("\r\n"),
);

const temporary: AliasRepo.NewAlias = {
  id: "al_temp",
  userId: "usr_1",
  domain: "tmp.test",
  localPart: "k7m2qx9pzr",
  mode: "inbox",
  createdAt: 0,
  inboxExpiresAt: 9_000_000_000_000,
  retentionDays: 1,
};

const world = () =>
  Layer.mergeAll(freshInbox(), AliasRepo.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(freshTable(), NodeCrypto.layer)),
  );

const createAlias = Effect.fn("createAlias")(function* () {
  const repo = yield* AliasRepo.AliasRepo;
  yield* repo.insert(temporary);
  return yield* Effect.fromOption(yield* repo.findByAddress(temporary.domain, temporary.localPart));
});

const listObjects = Effect.fn("listObjects")(function* () {
  const { bucket } = yield* TestInbox;
  const { url } = yield* FakeCloud.FakeCloud;
  return yield* Objects.keys(bucket, "inbox/").pipe(Effect.provide(AwsClient.emulator(url)));
});

describe("Inbox on fakecloud", () => {
  it.layer(FakeCloud.layer(), { timeout: 30_000 })((it) => {
    it.effect("stores sealed, lists the extracted code and reads the message back sanitized", () =>
      Effect.gen(function* () {
        const inbox = yield* Inbox.Inbox;
        const stored = yield* inbox.store(yield* createAlias(), otpMail);
        expect(stored.found.code).toEqual(Option.some("482913"));
        expect(stored.found.link).toEqual(Option.some("https://login.example/verify?token=abc"));

        // The body lies in the one-day class, and it is ciphertext.
        const keys = yield* listObjects();
        expect(keys).toEqual([`inbox/1d/al_temp/${stored.messageId}`]);
        const { bucket } = yield* TestInbox;
        const { url } = yield* FakeCloud.FakeCloud;
        const object = yield* Objects.get(bucket, keys[0] ?? "").pipe(
          Effect.provide(AwsClient.emulator(url)),
        );
        const asText = new TextDecoder("latin1").decode(object);
        expect(asText).not.toContain("482913");
        expect(asText).not.toContain("Subject");
        expect(asText).not.toContain("login.example");

        const [summary] = yield* inbox.list("al_temp", { after: Option.none(), limit: 10 });
        if (summary === undefined) return expect.fail("nothing listed");
        expect(summary).toMatchObject({
          id: stored.messageId,
          subject: Option.some("482913 is your sign-in code"),
          from: Option.some("Example Login <no-reply@login.example>"),
          preview: "Your verification code is 482913.",
          code: Option.some("482913"),
          link: Option.some("https://login.example/verify?token=abc"),
          attachmentCount: 0,
          size: otpMail.byteLength,
        });
        expect(Duration.toMillis(DateTime.distance(summary.receivedAt, summary.expiresAt))).toBe(
          86_400_000,
        );

        const read = yield* Effect.fromOption(yield* inbox.read("al_temp", stored.messageId));
        expect(read.text).toEqual(Option.some("Your verification code is 482913."));
        expect(read.blockedImageCount).toBe(1);
        const html = yield* Effect.fromOption(read.html);
        expect(html).not.toContain("script");
        expect(html).not.toContain("onclick");
        expect(html).not.toContain("track.example");
        expect(read.to).toEqual(Option.some("k7m2qx9pzr@tmp.test"));
        expect(yield* inbox.read("al_temp", "msg_none")).toEqual(Option.none());
      }).pipe(Effect.provide(world())),
    );

    it.effect("deletes one message with its object, and purges an alias's objects", () =>
      Effect.gen(function* () {
        const inbox = yield* Inbox.Inbox;
        const owner = yield* createAlias();
        const first = yield* inbox.store(owner, otpMail);
        const second = yield* inbox.store(owner, otpMail);
        expect(yield* inbox.remove("al_temp", first.messageId)).toBe(true);
        expect(yield* inbox.remove("al_temp", first.messageId)).toBe(false);
        expect(yield* listObjects()).toEqual([`inbox/1d/al_temp/${second.messageId}`]);
        expect(
          Arr.map(yield* inbox.list("al_temp", { after: Option.none(), limit: 10 }), (m) => m.id),
        ).toEqual([second.messageId]);
        yield* inbox.purge("al_temp");
        expect(yield* listObjects()).toEqual([]);
      }).pipe(Effect.provide(world())),
    );

    it.effect("leaves nothing behind when the alias was deleted meanwhile", () =>
      Effect.gen(function* () {
        const inbox = yield* Inbox.Inbox;
        const owner = yield* createAlias();
        yield* (yield* AliasRepo.AliasRepo).delete(temporary);
        const error = yield* Effect.flip(inbox.store(owner, otpMail));
        expect(error._tag).toBe("NoSuchAlias");
        expect(yield* listObjects()).toEqual([]);
      }).pipe(Effect.provide(world())),
    );

    it.effect("refuses bytes that are no message", () =>
      Effect.gen(function* () {
        const inbox = yield* Inbox.Inbox;
        const error = yield* Effect.flip(
          inbox.store(yield* createAlias(), bytes("\r\nno headers")),
        );
        expect(error._tag).toBe("UnreadableMessage");
        expect(yield* listObjects()).toEqual([]);
      }).pipe(Effect.provide(world())),
    );
  });
});
