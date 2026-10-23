import { FakeCloud } from "@alias/aws-emulators";
import { expect } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Browser from "./Browser.ts";
import type * as TestApi from "./TestApi.ts";

type Api = Effect.Success<typeof TestApi.make>;

/** A recipient as the API lists it, as far as these tests look. */
export const Recipient = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  isVerified: Schema.Boolean,
  isDefault: Schema.Boolean,
  createdAt: Schema.String,
});
export type Recipient = typeof Recipient.Type;

export const add = (browser: Browser.Client, address: string) =>
  browser.post("/v1/recipients", { address });

export const addRecipient = Effect.fn("addRecipient")(function* (
  browser: Browser.Client,
  address: string,
) {
  const response = yield* add(browser, address);
  expect(response.status).toBe(201);
  return Schema.decodeUnknownSync(Recipient)(response.body);
});

const LINK = /https:\/\/alias\.test\/destinations\?\S+/;

/** Every confirmation mail fakecloud SES accepted for `address`, oldest first. */
export const mailsTo = Effect.fn("mailsTo")(function* (api: Api, address: string) {
  const emails = yield* FakeCloud.sentEmails().pipe(Effect.provide(api.context));
  return Arr.map(
    Arr.filter(emails, (email) => Arr.contains(email.to, address)),
    (email) => {
      const text = Option.match(email.raw, {
        onNone: () => "",
        onSome: (raw) => new TextDecoder().decode(raw),
      });
      const link = new URL(
        Option.getOrElse(Option.fromUndefinedOr(LINK.exec(text)?.[0]), () => "x:"),
      );
      const param = (name: string) =>
        Option.getOrElse(Option.fromNullOr(link.searchParams.get(name)), () => "");
      return { email, text, recipientId: param("confirm"), token: param("token") };
    },
  );
});

export const lastMailTo = (api: Api, address: string) =>
  Effect.flatMap(mailsTo(api, address), (mails) => Effect.fromOption(Arr.last(mails)));

export const confirm = (browser: Browser.Client, recipientId: string, token: string) =>
  browser.post(`/v1/recipients/${recipientId}/confirm`, { token });

/** Adds `address` and confirms it with the token from the mail. */
export const addVerified = Effect.fn("addVerified")(function* (
  api: Api,
  browser: Browser.Client,
  address: string,
) {
  const added = yield* addRecipient(browser, address);
  const mail = yield* lastMailTo(api, address);
  expect((yield* confirm(browser, added.id, mail.token)).status).toBe(200);
  return added;
});
