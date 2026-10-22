import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ImageProxy, Keyring } from "../src/index.ts";
import { signer } from "./support/imageProxy.ts";

const pathOf = (url: string) => url.slice(signer.base.length);

const failure = (path: string, keys = signer.keys) =>
  Effect.map(Effect.flip(ImageProxy.verify(keys, path)), (error) => error.reason);

/** The same signer for another alias, or another owner. */
const signerFor = (owner: Partial<ImageProxy.Owner>): ImageProxy.AliasSigner => ({
  ...signer,
  owner: { ...signer.owner, ...owner },
});

layer(NodeCrypto.layer)((it) => {
  describe("ImageProxy", () => {
    it.effect("signs a URL that verifies back to exactly that URL and its owner", () =>
      Effect.gen(function* () {
        const original = "https://img.shop.example/a b/hero.jpg?w=600&h=300#x";
        const proxied = yield* ImageProxy.sign(signer, new URL(original).href);
        expect(proxied).toMatch(
          /^https:\/\/img\.alias\.test\/img\/1\/[\w-]{12}\/[\w-]{40}\/[\w-]{22}\/[\w-]+$/,
        );
        expect(ImageProxy.isProxied(signer, proxied)).toBe(true);
        const verified = yield* ImageProxy.verify(signer.keys, pathOf(proxied));
        expect(verified.url.href).toBe(new URL(original).href);
        expect(verified.userId).toBe(signer.owner.userId);
      }),
    );

    it.effect("never puts the user or alias id in the URL, nor links one owner's aliases", () =>
      Effect.gen(function* () {
        const url = "https://img.shop.example/a.png";
        const shop = yield* ImageProxy.sign(signer, url);
        const news = yield* ImageProxy.sign(signerFor({ aliasId: "al_news" }), url);
        expect(shop).not.toContain(signer.owner.userId);
        expect(shop).not.toContain(signer.owner.aliasId);
        const [, , , shopTag, shopOwner] = pathOf(shop).split("/");
        const [, , , newsTag, newsOwner] = pathOf(news).split("/");
        expect(newsTag).not.toBe(shopTag);
        expect(newsOwner).not.toBe(shopOwner);
        // Within an alias the same image keeps its URL, so CloudFront caches it once.
        expect(yield* ImageProxy.sign(signer, url)).toBe(shop);
        expect((yield* ImageProxy.verify(signer.keys, pathOf(news))).userId).toBe(
          signer.owner.userId,
        );
      }),
    );

    it.effect("refuses a URL whose owner was swapped for another user's", () =>
      Effect.gen(function* () {
        const url = "https://img.shop.example/a.png";
        const mine = pathOf(yield* ImageProxy.sign(signer, url)).split("/");
        const victim = pathOf(
          yield* ImageProxy.sign(signerFor({ userId: "usr_01jt8x2m4k5n6p7q8r9s0t1vzz" }), url),
        ).split("/");
        const swapped = [...mine.slice(0, 4), victim[4], ...mine.slice(5)].join("/");
        expect(yield* failure(swapped)).toBe("bad-signature");
        const elsewhere = pathOf(
          yield* ImageProxy.sign(signerFor({ aliasId: "al_news" }), url),
        ).split("/");
        const retagged = [...mine.slice(0, 3), elsewhere[3], ...mine.slice(4)].join("/");
        expect(yield* failure(retagged)).toBe("bad-signature");
      }),
    );

    it.effect("refuses a changed URL, a changed signature and unknown keys", () =>
      Effect.gen(function* () {
        const path = pathOf(yield* ImageProxy.sign(signer, "https://img.shop.example/a.png"));
        const [, , version, tag, owner, mac, payload] = path.split("/");
        const other = pathOf(yield* ImageProxy.sign(signer, "https://evil.example/a.png"));
        expect(
          yield* failure(`/img/${version}/${tag}/${owner}/${mac}/${other.split("/")[6]}`),
        ).toBe("bad-signature");
        const flipped = `${mac?.startsWith("A") ? "B" : "A"}${mac?.slice(1)}`;
        expect(yield* failure(`/img/${version}/${tag}/${owner}/${flipped}/${payload}`)).toBe(
          "bad-signature",
        );
        expect(yield* failure(`/img/7/${tag}/${owner}/${mac}/${payload}`)).toBe("unknown-key");

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
        const verified = yield* ImageProxy.verify(rotated, path);
        expect(verified.url.hostname).toBe("img.shop.example");
        expect(verified.userId).toBe(signer.owner.userId);
      }),
    );

    it.effect.each([
      "/img/",
      "/img/1/short/aGk",
      "/img/1/AAAAAAAAAAAAAAAAAAAAAA/aGk",
      "/img/1/AAAAAAAAAAAA/AAAA/AAAAAAAAAAAAAAAAAAAAAA/aGk/extra",
      "/img/1/AAAAAAAAAAAA/AAAA/AAAAAAAAAAAAAAAAAAAAAA/a+b",
      "/img/1/AAAAAAAAAAAA/A/AAAAAAAAAAAAAAAAAAAAAA/aGk",
      "/other/1/AAAAAAAAAAAA/AAAA/AAAAAAAAAAAAAAAAAAAAAA/aGk",
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
