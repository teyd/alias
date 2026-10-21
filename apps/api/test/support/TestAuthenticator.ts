// A software authenticator is test tooling, like the emulators: it needs real ECDSA keys.
// oxlint-disable-next-line effect/avoid-node-imports
import { type KeyObject, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import * as Arr from "effect/Array";
import { Base64Url } from "effect/encoding";
import * as Option from "effect/Option";

/**
 * A software passkey authenticator: what a browser plus platform authenticator would return
 * from `navigator.credentials.create()` and `.get()`, as JSON. It makes ES256 discoverable
 * credentials with `none` attestation and always reports user presence and verification.
 *
 * It is test tooling, not a mock: the server verifies its output with the same
 * `@simplewebauthn/server` code paths real browsers hit. Formats follow WebAuthn Level 3 §6.1
 * (authenticator data), §6.5 (attestation object) and §5.8.1 (client data).
 */

/** The parts of the creation options a browser reads. */
interface CreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
  readonly user: { readonly id: string };
}

interface RequestOptions {
  readonly challenge: string;
  readonly rpId?: string;
}

type NoExtensions = Readonly<Record<string, never>>;

/** Type aliases rather than interfaces, so credentials are plain JSON values. */
type RegistrationCredential = {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly clientExtensionResults: NoExtensions;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports: Array<string>;
  };
};

type AuthenticationCredential = {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly clientExtensionResults: NoExtensions;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle: string;
  };
};

export interface TestAuthenticator {
  readonly create: (options: CreationOptions) => RegistrationCredential;
  /** Answers with the newest credential for the RP, as a passkey chooser does by default. */
  readonly get: (options: RequestOptions) => AuthenticationCredential;
}

interface StoredCredential {
  readonly id: Uint8Array;
  readonly rpId: string;
  readonly userHandle: string;
  readonly privateKey: KeyObject;
  counter: number;
}

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array =>
  Uint8Array.from(Arr.flatMap(parts, (part) => Array.from(part)));

// CBOR (RFC 8949), only the major types WebAuthn structures use. Lengths stay below 2^16.
const cborHead = (major: number, length: number): Uint8Array => {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 0x100) return Uint8Array.of((major << 5) | 24, length);
  return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
};
const cborInt = (value: number) => (value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value));
const cborBytes = (value: Uint8Array) => concat(cborHead(2, value.length), value);
const cborText = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  return concat(cborHead(3, bytes.length), bytes);
};
const cborMap = (entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>) =>
  concat(cborHead(5, entries.length), ...Arr.flatMap(entries, (entry) => entry));

const sha256 = (data: Uint8Array | string) =>
  new Uint8Array(createHash("sha256").update(data).digest());

const uint32 = (value: number) =>
  Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

/**
 * The COSE_Key (RFC 9053) of a P-256 public key, for ES256 (alg -7). A P-256 SPKI ends with the
 * uncompressed point `04 || x || y`, so the coordinates are its last 64 bytes.
 */
const coseKey = (publicKey: KeyObject): Uint8Array => {
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  return cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(spki.slice(-64, -32))],
    [cborInt(-3), cborBytes(spki.slice(-32))],
  ]);
};

const clientData = (type: string, challenge: string, origin: string) =>
  new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

/** `origin` is what the browser puts in client data, e.g. `https://alias.test`. */
export const make = (origin: string): TestAuthenticator => {
  const credentials: Array<StoredCredential> = [];
  const rpIdOr = (id: Option.Option<string>) =>
    Option.getOrElse(id, () => new URL(origin).hostname);

  return {
    create: (options) => {
      const rpId = rpIdOr(Option.fromUndefinedOr(options.rp.id));
      const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const id = new Uint8Array(randomBytes(16));
      credentials.push({ id, rpId, userHandle: options.user.id, privateKey, counter: 0 });

      const authData = concat(
        sha256(rpId),
        Uint8Array.of(FLAG_UP | FLAG_UV | FLAG_AT),
        uint32(0),
        new Uint8Array(16), // AAGUID: all zeros for `none` attestation
        Uint8Array.of(id.length >> 8, id.length & 0xff),
        id,
        coseKey(publicKey),
      );
      const attestationObject = cborMap([
        [cborText("fmt"), cborText("none")],
        [cborText("attStmt"), cborMap([])],
        [cborText("authData"), cborBytes(authData)],
      ]);
      return {
        id: Base64Url.encode(id),
        rawId: Base64Url.encode(id),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: Base64Url.encode(
            clientData("webauthn.create", options.challenge, origin),
          ),
          attestationObject: Base64Url.encode(attestationObject),
          transports: ["internal"],
        },
      };
    },

    get: (options) => {
      const rpId = rpIdOr(Option.fromUndefinedOr(options.rpId));
      const credential = Option.getOrThrowWith(
        Arr.findLast(credentials, (stored) => stored.rpId === rpId),
        () => new Error(`no credential for ${rpId}`),
      );
      credential.counter += 1;
      const authData = concat(
        sha256(rpId),
        Uint8Array.of(FLAG_UP | FLAG_UV),
        uint32(credential.counter),
      );
      const clientDataJSON = clientData("webauthn.get", options.challenge, origin);
      // ES256 signatures are DER-encoded, which is also node's default for ECDSA.
      const signature = sign(
        "sha256",
        concat(authData, sha256(clientDataJSON)),
        credential.privateKey,
      );
      return {
        id: Base64Url.encode(credential.id),
        rawId: Base64Url.encode(credential.id),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: Base64Url.encode(clientDataJSON),
          authenticatorData: Base64Url.encode(authData),
          signature: Base64Url.encode(new Uint8Array(signature)),
          userHandle: credential.userHandle,
        },
      };
    },
  };
};
