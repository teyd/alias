import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import event from "../fixtures/ses-lambda-event.json" with { type: "json" };
import { SesEvent } from "../src/index.ts";

describe("SesEvent (contract: AWS documentation payload)", () => {
  it.effect("decodes the documented Lambda action event", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(SesEvent.SesEvent)(event);
      const record = decoded.Records[0];
      expect(record?.ses.receipt.action.invocationType).toBe("Event");
      expect(record?.ses.receipt.dmarcVerdict.status).toBe("GRAY");
      expect(record?.ses.mail.commonHeaders.subject).toBe("This is a test");
    }),
  );
});
