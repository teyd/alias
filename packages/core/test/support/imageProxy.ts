import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { type ImageProxy, Keyring } from "../../src/index.ts";

/** A fixed test keyring, for forwarding and the proxy URLs it signs. */
export const signer: ImageProxy.Signer = {
  base: "https://img.alias.test",
  keys: Effect.runSync(
    Keyring.parse(Redacted.make(`1:${Buffer.alloc(32, 3).toString("base64url")}`)),
  ),
};
