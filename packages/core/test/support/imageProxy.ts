import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { type ImageProxy, Keyring } from "../../src/index.ts";

/** A fixed test keyring and alias, for forwarding and the proxy URLs it signs. */
export const signer: ImageProxy.AliasSigner = {
  base: "https://img.alias.test",
  keys: Effect.runSync(
    Keyring.parse(Redacted.make(`1:${Buffer.alloc(32, 3).toString("base64url")}`)),
  ),
  owner: { aliasId: "al_shop", userId: "usr_01jt8x2m4k5n6p7q8r9s0t1v2w" },
};
