import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import bounce from "../fixtures/ses-event-bounce.json" with { type: "json" };
import complaint from "../fixtures/ses-event-complaint.json" with { type: "json" };
import { SendingEvent } from "../src/index.ts";

const message = (value: Schema.Json) => JSON.stringify(value);

describe("SendingEvent (contract: AWS documentation payloads)", () => {
  it.effect("decodes the documented bounce record", () =>
    Effect.gen(function* () {
      const decoded = yield* SendingEvent.decode(message(bounce));
      expect(SendingEvent.isBounce(decoded)).toBe(true);
      expect(decoded).toMatchObject({
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [
            {
              emailAddress: "recipient@example.com",
              status: "5.1.1",
              diagnosticCode: "smtp; 550 5.1.1 user unknown",
            },
          ],
        },
        mail: { messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000" },
      });
    }),
  );

  it.effect("decodes the documented complaint record", () =>
    Effect.gen(function* () {
      const decoded = yield* SendingEvent.decode(message(complaint));
      expect(SendingEvent.isComplaint(decoded)).toBe(true);
      expect(decoded).toMatchObject({
        complaint: { complainedRecipients: [{ emailAddress: "recipient@example.com" }] },
      });
    }),
  );

  it.effect("passes other event types on as Other, but rejects a broken bounce", () =>
    Effect.gen(function* () {
      expect(yield* SendingEvent.decode(message({ eventType: "Delivery", mail: {} }))).toEqual({
        eventType: "Other",
        type: "Delivery",
      });
      const broken = yield* Effect.flip(
        SendingEvent.decode(message({ ...bounce, bounce: { bounceType: "Permanent" } })),
      );
      expect(broken._tag).toBe("InvalidSendingEvent");
      expect((yield* Effect.flip(SendingEvent.decode("not json")))._tag).toBe(
        "InvalidSendingEvent",
      );
    }),
  );

  it.effect("reads back the user and kind a send was tagged with", () =>
    Effect.gen(function* () {
      const tagged = {
        ...bounce,
        mail: {
          ...bounce.mail,
          tags: {
            ...bounce.mail.tags,
            ...R.fromEntries(
              SendingEvent.tags("usr_1", "forward").map((tag) => [tag.name, [tag.value]] as const),
            ),
          },
        },
      };
      const decoded = yield* SendingEvent.decode(message(tagged));
      expect(SendingEvent.isBounce(decoded) && SendingEvent.origin(decoded.mail)).toEqual({
        userId: Option.some("usr_1"),
        kind: Option.some("forward"),
      });
      const untagged = yield* SendingEvent.decode(message(bounce));
      expect(SendingEvent.isBounce(untagged) && SendingEvent.origin(untagged.mail)).toEqual({
        userId: Option.none(),
        kind: Option.none(),
      });
    }),
  );
});
