import { Api, DEVICE_CODE_GRANT_TYPE, type DeviceClientId, type Scope } from "@alias/contracts";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpApiClient } from "effect/http-api";

/** @public What the person needs to approve the login: shown by the client, typed on the web. */
export interface Started {
  /** As shown: `BCDF-GHJK`. */
  readonly userCode: string;
  readonly verificationUri: string;
  /** `verificationUri` with the code filled in. */
  readonly verificationUriComplete: string;
  readonly expiresIn: Duration.Duration;
}

/** The login ended without a token: denied, expired, or refused outright. */
export class DeviceLoginFailed extends Schema.TaggedError<DeviceLoginFailed>()(
  "DeviceLoginFailed",
  { reason: Schema.String },
) {}

export interface Options {
  /** Where the API answers (the web app's origin). */
  readonly baseUrl: string;
  readonly clientId: DeviceClientId;
  readonly scopes: Arr.NonEmptyReadonlyArray<Scope>;
  /** Shows the code; polling starts once it returns. */
  readonly onCode: (started: Started) => Effect.Effect<void>;
}

/**
 * A device login (OAuth 2.0 device authorization grant, RFC 8628): asks for a code, hands it to
 * `onCode`, then polls at the server's interval, 5 seconds longer after each `slow_down` (§3.5),
 * until the person approves or denies it on the web or it expires. Succeeds with the issued API
 * token. Needs an `HttpClient`.
 */
export const login = Effect.fn("DeviceLogin.login")(function* (options: Options) {
  const client = yield* HttpApiClient.make(Api, { baseUrl: options.baseUrl });
  const started = yield* client.oauth.deviceAuthorization({
    payload: { client_id: options.clientId, scope: Arr.join(options.scopes, " ") },
  });
  yield* options.onCode({
    userCode: started.user_code,
    verificationUri: started.verification_uri,
    verificationUriComplete: started.verification_uri_complete,
    expiresIn: Duration.seconds(started.expires_in),
  });

  const poll = (
    interval: number,
  ): Effect.Effect<
    { readonly token: Redacted.Redacted<string>; readonly scope: string },
    DeviceLoginFailed | Effect.Error<ReturnType<typeof client.oauth.token>>
  > =>
    Effect.sleep(Duration.seconds(interval)).pipe(
      Effect.andThen(
        client.oauth.token({
          payload: {
            grant_type: DEVICE_CODE_GRANT_TYPE,
            device_code: started.device_code,
            client_id: options.clientId,
          },
        }),
      ),
      Effect.map((issued) => ({
        token: Redacted.make(issued.access_token),
        scope: issued.scope,
      })),
      Effect.catchTag("OAuthError", (error) => {
        if (error.error === "authorization_pending") return poll(interval);
        if (error.error === "slow_down") return poll(interval + 5);
        return Effect.fail(new DeviceLoginFailed({ reason: error.error }));
      }),
    );

  return yield* poll(started.interval);
});
