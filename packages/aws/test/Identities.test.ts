import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import created from "../fixtures/sesv2-create-email-identity-response.json" with { type: "json" };
import fetched from "../fixtures/sesv2-get-email-identity-response.json" with { type: "json" };
import { Identities } from "../src/index.ts";

const decode = Schema.decodeUnknownEffect(Identities.IdentityResponse);

describe("Identities (contract: AWS documentation payloads)", () => {
  it.effect("decodes the documented CreateEmailIdentity response: pending, three tokens", () =>
    Effect.gen(function* () {
      const response = yield* decode(created);
      expect(response.VerifiedForSendingStatus).toBe(false);
      expect(response.DkimAttributes.Status).toBe("PENDING");
      expect(response.DkimAttributes.Tokens).toHaveLength(3);
      expect(response.DkimAttributes.SigningHostedZone).toBe("dkim.amazonses.com");
    }),
  );

  it.effect("decodes the documented GetEmailIdentity response", () =>
    Effect.gen(function* () {
      const response = yield* decode(fetched);
      expect(response.VerifiedForSendingStatus).toBe(true);
      expect(response.DkimAttributes.Status).toBe("SUCCESS");
    }),
  );

  it.effect("refuses an email-address identity and an unknown DKIM status", () =>
    Effect.gen(function* () {
      yield* Effect.flip(decode({ ...created, IdentityType: "EMAIL_ADDRESS" }));
      yield* Effect.flip(
        decode({ ...created, DkimAttributes: { ...created.DkimAttributes, Status: "Success" } }),
      );
    }),
  );
});
