import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ImageProxy, Keyring } from "../src/index.ts";
import { signer } from "./support/imageProxy.ts";

const pathOf = (url: string) => url.slice(signer.base.length);

const failure = (path: string, keys = signer.keys) =>
  Effect.map(Effect.flip(ImageProxy.verify(keys, path)), (error) => error.reason);

layer(NodeCrypto.layer)((it) => {
  describe("ImageProxy", () => {
    it.effect("signs a URL that verifies back to exactly that URL", () =>
      Effect.gen(function* () {
        const original = "https://img.shop.example/a b/hero.jpg?w=600&h=300#x";
        const proxied = yield* ImageProxy.sign(signer, new URL(original).href);
        expect(proxied).toMatch(/^https:\/\/img\.alias\.test\/img\/1\/[\w-]{22}\/[\w-]+$/);
        expect(ImageProxy.isProxied(signer, proxied)).toBe(true);
        expect((yield* ImageProxy.verify(signer.keys, pathOf(proxied))).href).toBe(
          new URL(original).href,
        );
      }),
    );

    it.effect("refuses a changed URL, a changed signature and unknown keys", () =>
      Effect.gen(function* () {
        const path = pathOf(yield* ImageProxy.sign(signer, "https://img.shop.example/a.png"));
        const [, , version, mac, payload] = path.split("/");
        const other = pathOf(yield* ImageProxy.sign(signer, "https://evil.example/a.png"));
        expect(yield* failure(`/img/${version}/${mac}/${other.split("/")[4]}`)).toBe(
          "bad-signature",
        );
        const flipped = `${mac?.startsWith("A") ? "B" : "A"}${mac?.slice(1)}`;
        expect(yield* failure(`/img/${version}/${flipped}/${payload}`)).toBe("bad-signature");
        expect(yield* failure(`/img/7/${mac}/${payload}`)).toBe("unknown-key");

        const otherKeys = yield* Keyring.parse(
          Redacted.make(`1:${Buffer.alloc(32, 4).toString("base64url")}`),
        );
        expect(yield* failure(path, otherKeys)).toBe("bad-signature");
      }),
    );

    it.effect("keeps verifying with a retired key after a rotation", () =>
      Effect.gen(function* () {
        const path = pathOf(yield* ImageProxy.sign(signer, "https://img.shop.example/a.png"));
        const rotated = yield* Keyring.parse(
          Redacted.make(
            `2:${Buffer.alloc(32, 9).toString("base64url")},1:${Buffer.alloc(32, 3).toString("base64url")}`,
          ),
        );
        expect((yield* ImageProxy.verify(rotated, path)).hostname).toBe("img.shop.example");
      }),
    );

    it.effect.each([
      "/img/",
      "/img/1/short/aGk",
      "/other/1/AAAAAAAAAAAAAAAAAAAAAA/aGk",
      "/img/1/AAAAAAAAAAAAAAAAAAAAAA/aGk/extra",
      "/img/1/AAAAAAAAAAAAAAAAAAAAAA/a+b",
    ])("refuses the malformed path %s", (path) =>
      Effect.map(failure(path), (reason) => expect(reason).toBe("malformed")),
    );

    it.effect("never hands out a signed non-http URL", () =>
      Effect.gen(function* () {
        const path = pathOf(yield* ImageProxy.sign(signer, "file:///etc/passwd"));
        expect(yield* failure(path)).toBe("malformed");
      }),
    );
  });
});
