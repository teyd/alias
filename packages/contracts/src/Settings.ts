import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { requires } from "./Scopes.ts";

const ImageProtection = Schema.Literals(["off", "block-trackers", "proxy-images"]);

/** The caller's account settings. */
const Settings = Schema.Struct({
  /**
   * Mail to an address on the caller's own subdomain that has no alias yet creates the alias and
   * is forwarded, instead of being dropped. Off until the caller turns it on.
   */
  isOnTheFlyEnabled: Schema.Boolean,
  /**
   * What forwarding does with remote images in HTML mail: `block-trackers` (the default) removes
   * tracking pixels and images from known trackers; `proxy-images` also loads every other remote
   * image through our image proxy, so senders never see the reader's address or mail client;
   * `off` leaves every image as it came.
   */
  imageProtection: ImageProtection,
  /**
   * Forwarding removes click-tracking parameters (`utm_*`, `fbclid`, …) from links. Off until the
   * caller turns it on, since a few sites need them.
   */
  isLinkCleaningEnabled: Schema.Boolean,
  /**
   * Mail that can't be forwarded for good (SES refused it, the forwarding address is paused, its
   * OpenPGP key no longer encrypts) is kept encrypted for 7 days with its failed delivery, to
   * download or send again. Off until the caller turns it on: by default only when, which alias,
   * who wrote and why are recorded.
   */
  isFailedMailKept: Schema.Boolean,
});

export type Settings = typeof Settings.Type;

/** Only what's given changes. */
const SettingsChanges = Schema.Struct({
  isOnTheFlyEnabled: Schema.optionalKey(Schema.Boolean),
  imageProtection: Schema.optionalKey(ImageProtection),
  isLinkCleaningEnabled: Schema.optionalKey(Schema.Boolean),
  isFailedMailKept: Schema.optionalKey(Schema.Boolean),
});

/** Signed-in only. */
export const SettingsGroup = HttpApiGroup.make("settings")
  .add(requires("settings:read")(HttpApiEndpoint.get("get", "/settings", { success: Settings })))
  .add(
    requires("settings:write")(
      HttpApiEndpoint.patch("update", "/settings", { payload: SettingsChanges, success: Settings }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");
