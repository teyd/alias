import { Parameters } from "@alias/aws";
import { type ImageProxy, Keyring } from "@alias/core";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/**
 * Where the image proxy is served and the keys forwarding signs its URLs with (PLAN.md §20.19).
 * The proxy Lambda (`apps/image-proxy`) reads the same keys to verify them.
 */
export class ImageProxySigner extends Context.Service<ImageProxySigner, ImageProxy.Signer>()(
  "@alias/inbound/ImageProxySigner",
) {}

/** Keys given as a value: tests and `bin/`. */
export const layer = (base: string, keys: Redacted.Redacted<string>) =>
  Layer.effect(
    ImageProxySigner,
    Effect.map(Keyring.parse(keys), (parsed) => ({ base, keys: parsed })),
  );

/** The keys from a `SecureString` in SSM Parameter Store (`Parameters.keyring`). */
export const fromParameter = (base: string, name: string) =>
  Layer.effect(
    ImageProxySigner,
    Effect.map(Parameters.keyring(name), (keys) => ({ base, keys })),
  );

const parseUrl = Option.liftThrowable((value: string) => new URL(value));

/** The proxy's origin: an absolute http(s) URL with nothing after the host. */
const ProxyOrigin = Config.String("ALIAS_IMAGE_PROXY_URL").pipe(
  Config.mapEffect((value) =>
    Option.match(
      Option.filter(
        parseUrl(value),
        (url) => (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/",
      ),
      {
        onNone: () =>
          Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: `ALIAS_IMAGE_PROXY_URL ${value}: expected an origin such as https://img.alias.example`,
              }),
            ),
          ),
        onSome: (url) => Effect.succeed(url.origin),
      },
    ),
  ),
);

/**
 * `ALIAS_IMAGE_PROXY_URL` (`https://img.alias.example`) and `ALIAS_IMAGE_PROXY_KEYS_PARAMETER`
 * (the parameter's name, `Parameters.keyringConfig`).
 */
export const config = Config.all({
  base: ProxyOrigin,
  keys: Parameters.keyringConfig("ALIAS_IMAGE_PROXY_KEYS_PARAMETER"),
}).pipe(
  Config.map(({ base, keys }) =>
    Layer.effect(
      ImageProxySigner,
      Effect.map(keys, (loaded) => ({ base, keys: loaded })),
    ),
  ),
);
