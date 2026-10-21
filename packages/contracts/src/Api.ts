import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

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

const AliasesGroup = HttpApiGroup.make("aliases")
  .add(
    HttpApiEndpoint.get("lookup", "/aliases/:domain/:local", {
      params: { domain: Schema.String, local: Schema.String },
      success: AliasView,
      error: AliasNotFound,
    }),
  )
  .prefix("/v1");

export const Api = HttpApi.make("alias").add(SystemGroup).add(AliasesGroup);
