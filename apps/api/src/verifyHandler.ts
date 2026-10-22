/** Lambda entrypoint (EventBridge Scheduler): the custom-domain verification cron. */
import { Identities, type LambdaHandler } from "@alias/aws";
import { DomainRepo, Dynamo } from "@alias/db";
import { Doh } from "@alias/dns";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as DomainVerification from "./DomainVerification.ts";

/** `ALIAS_TABLE_NAME`, `ALIAS_DOH_URL`, and the endpoint overrides only emulated runs set. */
const ServicesConfig = Config.all([Dynamo.config, Identities.config, Doh.config]).pipe(
  Config.map((layers) => DomainRepo.layer.pipe(Layer.provideMerge(Layer.mergeAll(...layers)))),
);

const runtime = ManagedRuntime.make(Effect.runSync(ServicesConfig));

/**
 * @public Alchemy bundles it as the verification Lambda. The schedule's payload is ignored: each
 * run checks the domains that are due (`DomainRepo.due`). A failure rejects, and Scheduler's
 * retry policy runs it again; checking a domain twice is harmless.
 */
export default (() =>
  runtime.runPromise(
    DomainVerification.runDue().pipe(
      Effect.tap((outcome) => Effect.logInfo("domains checked", outcome)),
      Effect.asVoid,
    ),
  )) satisfies LambdaHandler<unknown, void>;
