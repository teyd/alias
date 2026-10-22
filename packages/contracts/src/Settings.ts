import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Authentication } from "./Auth.ts";

/** The caller's account settings. */
const Settings = Schema.Struct({
  /**
   * Mail to an address on the caller's own subdomain that has no alias yet creates the alias and
   * is forwarded, instead of being dropped. Off until the caller turns it on.
   */
  isOnTheFlyEnabled: Schema.Boolean,
});

/** Only what's given changes. */
const SettingsChanges = Schema.Struct({
  isOnTheFlyEnabled: Schema.optionalKey(Schema.Boolean),
});

/** Signed-in only. */
export const SettingsGroup = HttpApiGroup.make("settings")
  .add(HttpApiEndpoint.get("get", "/settings", { success: Settings }))
  .add(
    HttpApiEndpoint.patch("update", "/settings", { payload: SettingsChanges, success: Settings }),
  )
  .middleware(Authentication)
  .prefix("/v1");
