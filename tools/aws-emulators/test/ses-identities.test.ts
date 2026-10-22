import { AwsClient, Identities } from "@alias/aws";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FakeCloud } from "../src/index.ts";

const client = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);
const live = Identities.layer.pipe(
  Layer.provideMerge(client),
  Layer.provideMerge(FakeCloud.layer()),
);

/**
 * SESv2 domain identities on fakecloud v0.51.0, through the production `Identities` service.
 * Read in its source (`crates/fakecloud-ses/src/service/identities.rs`) first; the divergences
 * from AWS it shows are pinned here so a fakecloud upgrade that changes them is noticed.
 */
describe("SES identities on fakecloud (SESv2 CreateEmailIdentity, GetEmailIdentity, …)", () => {
  it.layer(live, { timeout: 30_000 })((it) => {
    it.effect("creates a domain identity whose responses decode with the production schema", () =>
      Effect.gen(function* () {
        const identities = yield* Identities.Identities;
        const created = yield* identities.create("custom.example", "bounce.custom.example");
        expect(created.dkimTokens).toHaveLength(3);
        const fetched = yield* identities.get("custom.example");
        expect(Option.map(fetched, (identity) => identity.dkimTokens)).toEqual(
          Option.some(created.dkimTokens),
        );
      }),
    );

    it.effect("sets the custom MAIL FROM domain and turns feedback forwarding off", () =>
      Effect.gen(function* () {
        const identities = yield* Identities.Identities;
        yield* identities.create("mailfrom.example", "bounce.mailfrom.example");
        const raw = yield* SESV2.getEmailIdentity({ EmailIdentity: "mailfrom.example" });
        expect(raw.MailFromAttributes?.MailFromDomain).toBe("bounce.mailfrom.example");
        expect(raw.MailFromAttributes?.BehaviorOnMxFailure).toBe("USE_DEFAULT_VALUE");
        expect(raw.FeedbackForwardingStatus).toBe(false);
      }),
    );

    it.effect("a second create fails as IdentityExists; delete is idempotent", () =>
      Effect.gen(function* () {
        const identities = yield* Identities.Identities;
        yield* identities.create("twice.example", "bounce.twice.example");
        const again = yield* Effect.flip(
          identities.create("twice.example", "bounce.twice.example"),
        );
        expect(again._tag).toBe("IdentityExists");
        yield* identities.delete("twice.example");
        expect(yield* identities.get("twice.example")).toEqual(Option.none());
        yield* identities.delete("twice.example");
        yield* identities.create("twice.example", "bounce.twice.example");
      }),
    );

    it.effect("diverges from AWS: verified at once, fixed DKIM tokens, no hosted zone", () =>
      Effect.gen(function* () {
        const identities = yield* Identities.Identities;
        const created = yield* identities.create("instant.example", "bounce.instant.example");
        // AWS answers PENDING and unverified until it finds the CNAMEs (up to 72 hours), with
        // random tokens per identity.
        expect(created).toEqual({
          isVerifiedForSending: true,
          dkimStatus: "SUCCESS",
          dkimTokens: ["token1", "token2", "token3"],
          dkimZone: Option.none(),
        });
        // The documented MailFromDomainStatus values are upper case (PENDING, SUCCESS, …).
        const raw = yield* SESV2.getEmailIdentity({ EmailIdentity: "instant.example" });
        expect(raw.MailFromAttributes?.MailFromDomainStatus).toBe("Success");
      }),
    );
  });
});
