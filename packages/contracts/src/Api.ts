import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AccountGroup, AuthGroup, Authentication } from "./Auth.ts";

const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

const AliasView = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  mode: Schema.Literals(["forward", "inbox", "both"]),
  isActive: Schema.Boolean,
});

export class AliasNotFound extends Schema.TaggedError<AliasNotFound>()(
  "AliasNotFound",
  { address: Schema.String },
  { httpApiStatus: 404 },
) {}

const SystemGroup = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/health", { success: Health }),
);

/** Signed-in only. Other users' aliases answer `AliasNotFound`, so lookups reveal nothing. */
const AliasesGroup = HttpApiGroup.make("aliases")
  .add(
    HttpApiEndpoint.get("lookup", "/aliases/:domain/:local", {
      params: { domain: Schema.String, local: Schema.String },
      success: AliasView,
      error: AliasNotFound,
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");

export const Api = HttpApi.make("alias")
  .add(SystemGroup)
  .add(AuthGroup)
  .add(AccountGroup)
  .add(AliasesGroup);
