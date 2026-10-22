import type { WebhookUrl } from "@alias/core";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** Which webhook URLs are allowed here (`WebhookUrl.check`), for registration and delivery. */
export class UrlPolicy extends Context.Service<UrlPolicy, WebhookUrl.Options>()(
  "@alias/webhooks/UrlPolicy",
) {}

export const layer = (options: WebhookUrl.Options) => Layer.succeed(UrlPolicy, options);

/**
 * `ALIAS_WEBHOOK_ALLOW_LOOPBACK=true` admits `http://localhost` and loopback addresses: `pnpm dev`
 * and tests only. Production never sets it (`infra/alchemy.run.ts`), so there webhook URLs must
 * be `https:` on public addresses.
 */
export const config = Config.Boolean("ALIAS_WEBHOOK_ALLOW_LOOPBACK").pipe(
  Config.withDefault(false),
  Config.map((isLoopbackAllowed) => layer({ isLoopbackAllowed })),
);
