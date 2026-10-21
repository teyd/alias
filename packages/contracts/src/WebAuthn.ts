import * as Schema from "effect/Schema";

/**
 * The JSON forms of WebAuthn options and credentials (WebAuthn Level 3 `toJSON()`), limited to
 * the fields Alias sends and reads. Binary values are base64url strings. Extensions are left out,
 * since the server requests none. Arrays are mutable so values pass straight into
 * `@simplewebauthn/browser` and `@simplewebauthn/server`, whose types use mutable arrays.
 * https://www.w3.org/TR/webauthn-3/#dictdef-publickeycredentialcreationoptionsjson
 */
const Base64Url = Schema.String;

const PublicKey = Schema.Literal("public-key");

const UserVerification = Schema.Literals(["required", "preferred", "discouraged"]);

const AuthenticatorAttachment = Schema.Literals(["platform", "cross-platform"]);

const CredentialDescriptor = Schema.Struct({
  id: Base64Url,
  type: Schema.String,
  transports: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

export const CreationOptions = Schema.Struct({
  rp: Schema.Struct({ id: Schema.optionalKey(Schema.String), name: Schema.String }),
  user: Schema.Struct({ id: Base64Url, name: Schema.String, displayName: Schema.String }),
  challenge: Base64Url,
  pubKeyCredParams: Schema.mutable(
    Schema.Array(Schema.Struct({ alg: Schema.Number, type: PublicKey })),
  ),
  timeout: Schema.optionalKey(Schema.Number),
  excludeCredentials: Schema.optionalKey(Schema.mutable(Schema.Array(CredentialDescriptor))),
  authenticatorSelection: Schema.optionalKey(
    Schema.Struct({
      authenticatorAttachment: Schema.optionalKey(AuthenticatorAttachment),
      residentKey: Schema.optionalKey(Schema.Literals(["required", "preferred", "discouraged"])),
      // `requireResidentKey` is the spec's name for this boolean, not ours to choose.
      // oxlint-disable-next-line effect/require-is-prefix-for-boolean-schema-field
      requireResidentKey: Schema.optionalKey(Schema.Boolean),
      userVerification: Schema.optionalKey(UserVerification),
    }),
  ),
  attestation: Schema.optionalKey(Schema.Literals(["none", "indirect", "direct", "enterprise"])),
});
export type CreationOptions = typeof CreationOptions.Type;

export const RequestOptions = Schema.Struct({
  challenge: Base64Url,
  timeout: Schema.optionalKey(Schema.Number),
  rpId: Schema.optionalKey(Schema.String),
  allowCredentials: Schema.optionalKey(Schema.mutable(Schema.Array(CredentialDescriptor))),
  userVerification: Schema.optionalKey(UserVerification),
});
export type RequestOptions = typeof RequestOptions.Type;

/** What `navigator.credentials.create()` returned, as JSON. */
export const RegistrationCredential = Schema.Struct({
  id: Base64Url,
  rawId: Base64Url,
  type: PublicKey,
  authenticatorAttachment: Schema.optionalKey(AuthenticatorAttachment),
  clientExtensionResults: Schema.Struct({}),
  response: Schema.Struct({
    clientDataJSON: Base64Url,
    attestationObject: Base64Url,
    authenticatorData: Schema.optionalKey(Base64Url),
    transports: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
    publicKeyAlgorithm: Schema.optionalKey(Schema.Number),
    publicKey: Schema.optionalKey(Base64Url),
  }),
});
export type RegistrationCredential = typeof RegistrationCredential.Type;

/** What `navigator.credentials.get()` returned, as JSON. */
export const AuthenticationCredential = Schema.Struct({
  id: Base64Url,
  rawId: Base64Url,
  type: PublicKey,
  authenticatorAttachment: Schema.optionalKey(AuthenticatorAttachment),
  clientExtensionResults: Schema.Struct({}),
  response: Schema.Struct({
    clientDataJSON: Base64Url,
    authenticatorData: Base64Url,
    signature: Base64Url,
    userHandle: Schema.optionalKey(Base64Url),
  }),
});
export type AuthenticationCredential = typeof AuthenticationCredential.Type;
