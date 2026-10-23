import { AwsClient } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { Dynamo, WebhookRepo } from "@alias/db";
import { Secrets } from "@alias/webhooks";
import { TestQueue, testWebhookKeys } from "@alias/webhooks/testing";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestApi from "./support/TestApi.ts";

const Created = Schema.Struct({ id: Schema.String, secret: Schema.String });

const hook = { url: "https://hooks.example.com/alias", eventTypes: ["alias.created"] };

/** The bodies of the messages waiting on the test's webhook queue. */
const queued = (api: Effect.Success<typeof TestApi.make>) =>
  Effect.gen(function* () {
    const { queueUrl } = yield* TestQueue;
    const { url } = yield* FakeCloud.FakeCloud;
    const { Messages = [] } = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
    }).pipe(Effect.provide(AwsClient.emulator(url)));
    return Arr.map(Messages, (message) => JSON.parse(message.Body ?? "null"));
  }).pipe(Effect.provide(api.context));

describe("webhooks API (handler on fakecloud)", () => {
  it.effect("registers an endpoint, shows its secret once, and lists it without", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      const created = yield* browser.post("/v1/webhooks", hook);
      expect(created.status).toBe(201);
      const { id, secret } = Schema.decodeUnknownSync(Created)(created.body);
      expect(secret).toMatch(/^whsec_/);
      const listed = yield* browser.get("/v1/webhooks");
      expect(listed.body).toEqual([
        {
          id,
          url: hook.url,
          eventTypes: ["alias.created"],
          isEnabled: true,
          createdAt: expect.any(String),
        },
      ]);
      expect(JSON.stringify(listed.body)).not.toContain(secret);

      const paused = yield* browser.patch(`/v1/webhooks/${id}`, { isEnabled: false });
      expect(paused.body).toMatchObject({ isEnabled: false });
      const rotated = yield* browser.post(`/v1/webhooks/${id}/secret`);
      expect(rotated.status).toBe(200);
      const fresh = Schema.decodeUnknownSync(Created)(rotated.body).secret;
      expect(fresh).toMatch(/^whsec_/);
      expect(fresh).not.toBe(secret);
      expect((yield* browser.delete(`/v1/webhooks/${id}`)).status).toBe(204);
      expect((yield* browser.get("/v1/webhooks")).body).toEqual([]);
    }),
  );

  // SR-13 (PLAN.md §20.25): anyone reading the table or a backup could forge deliveries.
  it.effect("stores the signing secret only sealed, bound to its webhook", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const created = Schema.decodeUnknownSync(Created)(
        (yield* ada.browser.post("/v1/webhooks", hook)).body,
      );
      const other = Schema.decodeUnknownSync(Created)(
        (yield* ada.browser.post("/v1/webhooks", hook)).body,
      );
      const rotated = Schema.decodeUnknownSync(Created)(
        (yield* ada.browser.post(`/v1/webhooks/${created.id}/secret`)).body,
      );
      const { name } = yield* Effect.provide(Effect.service(Dynamo.DynamoTable), api.context);
      const table = JSON.stringify(
        yield* DynamoDB.scan({ TableName: name }).pipe(Effect.provide(api.context)),
      );
      const keyOf = (secret: string) => secret.slice("whsec_".length);
      const exposed = Arr.filter([created.secret, other.secret, rotated.secret], (secret) =>
        table.includes(keyOf(secret)),
      );
      expect(exposed).toEqual([]);

      // The delivery side opens them with the same keys; each only for its own webhook.
      const opened = yield* Effect.gen(function* () {
        const repo = yield* WebhookRepo.WebhookRepo;
        const stored = yield* Effect.flatMap(repo.find(ada.userId, created.id), Effect.fromOption);
        const owner = { userId: ada.userId, webhookId: created.id };
        const current = yield* Secrets.open(owner, stored.sealedSecret);
        const previous = yield* Secrets.open(
          owner,
          yield* Effect.fromOption(stored.previousSealedSecret),
        );
        const moved = yield* Effect.flip(
          Secrets.open({ userId: ada.userId, webhookId: other.id }, stored.sealedSecret),
        );
        return { current: Redacted.value(current), previous: Redacted.value(previous), moved };
      }).pipe(
        Effect.provide(
          Layer.merge(
            WebhookRepo.layer.pipe(Layer.provide(Layer.succeedContext(api.context))),
            testWebhookKeys(),
          ),
        ),
      );
      expect(opened.current).toBe(rotated.secret);
      expect(opened.previous).toBe(created.secret);
      expect(opened.moved._tag).toBe("SealError");
    }),
  );

  it.effect("refuses URLs that could reach inside: http, credentials, private hosts", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      const reasons = yield* Effect.forEach(
        [
          "http://hooks.example.com/",
          "https://user:pw@hooks.example.com/",
          "https://169.254.169.254/latest",
          "https://10.0.0.1/",
          "https://[::ffff:127.0.0.1]/",
          "https://intranet/",
          "not a url",
        ],
        (url) =>
          Effect.map(browser.post("/v1/webhooks", { ...hook, url }), (response) => [
            response.status,
            Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }))(response.body)
              .reason,
          ]),
        { concurrency: 1 },
      );
      expect(reasons).toEqual([
        [400, "not-https"],
        [400, "has-credentials"],
        [400, "not-public-host"],
        [400, "not-public-host"],
        [400, "not-public-host"],
        [400, "not-public-host"],
        [400, "invalid-url"],
      ]);
      expect((yield* browser.post("/v1/webhooks", { ...hook, eventTypes: [] })).status).toBe(400);
    }),
  );

  it.effect("caps endpoints per user, keeps them per user, and is session-only", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const grace = yield* TestApi.signedIn(api.browser, "grace");
      const ids = yield* Effect.forEach(
        Arr.range(1, 10),
        () =>
          Effect.map(
            ada.browser.post("/v1/webhooks", hook),
            (response) => Schema.decodeUnknownSync(Created)(response.body).id,
          ),
        { concurrency: 1 },
      );
      expect(yield* ada.browser.post("/v1/webhooks", hook)).toMatchObject({
        status: 409,
        body: { _tag: "TooManyWebhooks", limit: 10 },
      });
      const first = ids[0] ?? "";
      expect((yield* grace.browser.delete(`/v1/webhooks/${first}`)).status).toBe(404);
      expect((yield* grace.browser.post(`/v1/webhooks/${first}/secret`)).status).toBe(404);
      expect((yield* grace.browser.get("/v1/webhooks")).body).toEqual([]);

      const minted = yield* ada.browser.post("/v1/tokens", {
        name: "cli",
        scopes: ["aliases:read", "aliases:write"],
      });
      const token = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(minted.body);
      const client = api.withToken(token.token);
      expect((yield* client.get("/v1/webhooks")).status).toBe(403);
      expect((yield* client.post("/v1/webhooks", hook)).status).toBe(403);
    }),
  );

  it.effect("queues alias.created and alias.deleted for subscribed endpoints", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser, userId } = yield* TestApi.signedIn(api.browser, "ada");
      yield* browser.post("/v1/webhooks", {
        url: "http://127.0.0.1:9/hook",
        eventTypes: ["alias.created", "alias.deleted"],
      });
      const created = yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "forward",
      });
      const aliasId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        created.body,
      ).id;
      expect((yield* browser.delete("/v1/aliases/ada.alias.test/shop")).status).toBe(204);
      const jobs = yield* queued(api);
      expect(
        Arr.sort(
          Arr.map(jobs, (job) => String(job.event.type)),
          Order.String,
        ),
      ).toEqual(["alias.created", "alias.deleted"]);
      expect(jobs[0]).toMatchObject({
        userId,
        event: { data: { aliasId, address: "shop@ada.alias.test" } },
      });
    }),
  );
});
