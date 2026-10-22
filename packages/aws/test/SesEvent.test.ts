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

describe("SesEvent.decode", () => {
  it.effect("parses the documented event", () =>
    Effect.gen(function* () {
      const decoded = yield* SesEvent.decode(event);
      expect(decoded.Records).toHaveLength(1);
    }),
  );

  it.effect("fails typed on anything else", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(SesEvent.decode({ Records: [{ eventSource: "aws:sns" }] }));
      expect(error._tag).toBe("InvalidSesEvent");
    }),
  );
});
