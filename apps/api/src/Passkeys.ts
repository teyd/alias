import { PasskeyRejected } from "@alias/contracts";
import type { PasskeyRepo } from "@alias/db";
import * as SimpleWebAuthn from "@simplewebauthn/server";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import { RelyingParty } from "./RelyingParty.ts";

/** Ceremonies time out on the client after this long; challenges expire server-side too. */
export const CEREMONY_TIMEOUT_MILLIS = 5 * 60 * 1000;

/** Anything `@simplewebauthn/server` throws means the response did not verify. */
const rejected = () => new PasskeyRejected({ reason: "verification-failed" });

const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: rejected });

/** Discoverable credentials (passkeys) with user verification, no attestation. */
export const registrationOptions = Effect.fn("Passkeys.registrationOptions")(function* (input: {
  readonly userId: string;
  readonly username: string;
  readonly challenge: Uint8Array;
}) {
  const rp = yield* RelyingParty;
  return yield* call(() =>
    SimpleWebAuthn.generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: input.username,
      userDisplayName: input.username,
      userID: new TextEncoder().encode(input.userId),
      // A copy, because the library wants an ArrayBuffer-backed array.
      challenge: new Uint8Array(input.challenge),
      timeout: CEREMONY_TIMEOUT_MILLIS,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    }),
  );
});

export const verifyRegistration = Effect.fn("Passkeys.verifyRegistration")(function* (input: {
  readonly credential: SimpleWebAuthn.RegistrationResponseJSON;
  readonly expectedChallenge: string;
}) {
  const rp = yield* RelyingParty;
  const result = yield* call(() =>
    SimpleWebAuthn.verifyRegistrationResponse({
      response: input.credential,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
    }),
  );
  if (!result.verified) return yield* rejected();
  const { credential } = result.registrationInfo;
  return {
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
  };
});

/**
 * No `allowCredentials`: the authenticator offers whichever passkey it holds for this site. Built
 * by hand because there is nothing to compute, and the library's version has `undefined` fields
 * the JSON schema rejects.
 */
export const authenticationOptions = Effect.fn("Passkeys.authenticationOptions")(function* (
  challenge: Uint8Array,
) {
  const rp = yield* RelyingParty;
  return {
    challenge: Base64Url.encode(challenge),
    rpId: rp.id,
    timeout: CEREMONY_TIMEOUT_MILLIS,
    userVerification: "required" as const,
  };
});

/** Returns the new signature counter. */
export const verifyAuthentication = Effect.fn("Passkeys.verifyAuthentication")(function* (input: {
  readonly credential: SimpleWebAuthn.AuthenticationResponseJSON;
  readonly expectedChallenge: string;
  readonly passkey: PasskeyRepo.Passkey;
}) {
  const rp = yield* RelyingParty;
  const result = yield* call(() =>
    SimpleWebAuthn.verifyAuthenticationResponse({
      response: input.credential,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: {
        id: input.passkey.id,
        publicKey: new Uint8Array(input.passkey.publicKey),
        counter: input.passkey.counter,
        transports: [...input.passkey.transports],
      },
    }),
  );
  if (!result.verified) return yield* rejected();
  return result.authenticationInfo.newCounter;
});
