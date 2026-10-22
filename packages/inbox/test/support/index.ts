import { AwsClient, Objects } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { Keyring } from "@alias/core";
import { MessageRepo } from "@alias/db";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Inbox } from "../../src/index.ts";

/** A test keyring entry: `1:` and a fixed 32-byte secret (never used anywhere real). */
export const TEST_INBOX_KEYS = "1:dGVzdC1vbmx5LWluYm94LWtleS1ub3QtYS1zZWNyZXQ";

/** The bucket a test's inbox stores in, to look at the objects themselves. */
export class TestInbox extends Context.Service<TestInbox, { readonly bucket: string }>()(
  "@alias/inbox/testing/TestInbox",
) {}

let buckets = 0;

/**
 * A fresh inbox store on the test's fakecloud: its own bucket, the given keys, and `MessageRepo`
 * on the table in context (`freshTable()`).
 */
export const freshInbox = (keys = TEST_INBOX_KEYS) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { url } = yield* FakeCloud.FakeCloud;
      const client = AwsClient.emulator(url);
      buckets += 1;
      const bucket = `inbox-test-${buckets}`;
      yield* Objects.ensureBucket(bucket).pipe(Effect.provide(client), Effect.orDie);
      return Layer.merge(
        Layer.succeed(TestInbox, { bucket }),
        Inbox.layer(bucket).pipe(
          Layer.provide(
            Layer.effect(Inbox.InboxKeys, Effect.orDie(Keyring.parse(Redacted.make(keys)))),
          ),
          Layer.provide(MessageRepo.layer),
          Layer.provide(client),
        ),
      );
    }),
  );
