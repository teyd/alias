/**
 * Production infrastructure (AWS eu-west-1, DNS and Turnstile on Cloudflare). Not deployed yet.
 * Development and every test run against emulators (see AGENTS.md), and `pnpm check` typechecks
 * this file. Deploy with `pnpm infra:deploy` (`scripts/deploy.ts`: builds the web app, then runs
 * `alchemy deploy`). Every setting is in `infra/.env.example`; the steps no tool can do are
 * PLAN.md §20.37.
 *
 * The DynamoDB table comes from the same spec the emulators create (`@alias/db` Table.spec),
 * and the receipt rule matches the one `apps/inbound/bin/dev.ts` runs in the SES emulator.
 */
import { AwsClient, CloudFront, Parameters } from "@alias/aws";
import { RetentionDays } from "@alias/contracts";
import { OriginSecret } from "@alias/core";
import { Table } from "@alias/db";
import { Inbox } from "@alias/inbox";
import { securityHeaders } from "@alias/web/security-headers";
import { WebhookQueue } from "@alias/webhooks";
import * as ACM from "@distilled.cloud/aws/acm";
import {
  Credentials,
  type CredentialsError,
  type ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as ServiceQuotas from "@distilled.cloud/aws/service-quotas";
import * as SSM from "@distilled.cloud/aws/ssm";
import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { localState } from "alchemy/State";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

// The settings (`infra/.env.example`), also when Alchemy runs without `scripts/deploy.ts`: Alchemy
// reads `.env` into its own configuration only, and everything below reads `process.env`.
// Variables already set win.
const envFile = new URL(".env", import.meta.url).pathname;
if (existsSync(envFile)) process.loadEnvFile(envFile);

const stage = process.env.ALIAS_STAGE ?? "local";
const sharedDomains = (process.env.ALIAS_SHARED_DOMAINS ?? "alias.test").split(",");
// Passkeys are bound to the first shared domain, which serves the web app.
const appDomain = sharedDomains[0] ?? "alias.test";
// Must be on a shared domain (checked at cold start); those are the verified SES identities.
const confirmationSender = `no-reply@${appDomain}`;
const spoolBucketName = `alias-spool-${stage}`;
/** Custom-domain DNS checks resolve through Cloudflare's DoH JSON API (`Doh.cloudflare`). */
const dohUrl = "https://cloudflare-dns.com/dns-query";
const tableName = `alias-${stage}`;
/** Every send names it, so SES reports its bounces and complaints (PLAN.md §20.11). */
const configurationSetName = `alias-events-${stage}`;
/** Where SES stores received mail; `Inbound.spoolPrefix` in `@alias/aws`. */
const spoolPrefix = "inbound/";
/** Fixed names, so policies can name the receipt rule before it exists (`receiptRuleArn`). */
const receiptRuleSetName = `alias-inbound-${stage}`;
const receiptRuleName = "all-verified";
/** Webhook deliveries (PLAN.md §20.20), and where SQS moves those that exhausted their retries. */
const webhookQueueName = `alias-webhooks-${stage}`;
/** Fixed names, so the alarms and the topic policy can name each other as plain strings. */
const alertTopicName = `alias-alerts-${stage}`;
const alarmPrefix = `alias-${stage}-`;
/**
 * Async invocations (SES → inbound, SNS → feedback) that Lambda gave up on, after their retries
 * or after `maximumEventAge` of throttling (PLAN.md §20.29). Kept 14 days for a redrive.
 */
const asyncFailuresQueueName = `alias-async-failures-${stage}`;

/**
 * Reserved concurrency per function (PLAN.md §20.29). Each number both guarantees the function
 * that many concurrent executions and caps it there, so a flood on a public URL (the API, the
 * image proxy) can't take the executions SES-invoked mail processing needs, and SES's events are
 * never throttled by someone else's traffic. Reserving costs nothing; only use is billed.
 *
 * Together 352. Lambda keeps at least 100 unreserved, so the account's concurrency quota must be
 * at least 452; new accounts may start with as few as 10, so the stack asks for 1,000
 * (`lambdaConcurrencyQuota`, below).
 */
const reservedConcurrency = {
  /** SES mail: ~1 s each, so 100 handle bursts of ~100 messages a second. */
  inbound: 100,
  /** One SNS notification per bounce or complaint. */
  feedback: 10,
  /** Webhook deliveries; the event source mapping scales up to this. */
  webhookDelivery: 20,
  /** Uncached image fetches; budgets per owner and host share them (`Proxy.Budgets`). */
  imageProxy: 20,
  /** Every request of the web app, CLI, SDK and MCP clients; a cap more than a reservation. */
  api: 200,
  /** One run every ten minutes. */
  verifyDomains: 2,
} as const;
/**
 * Who gets the SES reputation alarms (PLAN.md §20.13). Optional: without it the topic and alarms
 * still exist (alarm state and history show in CloudWatch), but nobody is mailed. SNS sends a
 * confirmation mail first, and nothing is delivered until the link in it is followed.
 */
const alertEmail = process.env.ALIAS_ALERT_EMAIL?.trim() || undefined;

/**
 * Reverse-alias signing keys for the inbound Lambda (PLAN.md §20.14): `<version>:<base64url
 * secret>` entries, the first one minting (`Keyring.parse` in `@alias/core`; secrets of at
 * least 32 bytes). They live in an SSM Parameter Store `SecureString` (standard tier, free) that
 * the Lambda reads at cold start. This stack only names the parameter and grants reading it; it
 * never holds the value, so the value stays out of the Alchemy state and the Lambda console.
 * The `Keyring` action (`deployActions`, below) creates it with one fresh key if it is missing,
 * never touches an existing one and keeps the value out of the state; the default key `aws/ssm`
 * encrypts it.
 *
 * Rotate in two puts with `--overwrite`: first append the new key (`1:<old>,2:<new>`), then, once
 * every warm container has reloaded (or after any function configuration update), put it first
 * (`2:<new>,1:<old>`). Keep the old key for as long as replies to older mail should work.
 */
const reverseTokenKeysParameter = `/alias/${stage}/reverse-token-keys`;

/**
 * The image proxy's URL keys (PLAN.md §20.19): the inbound Lambda signs proxy URLs with them and
 * the image proxy Lambda verifies them. Same format, storage and two-step rotation as the
 * reverse-token keys; the `Keyring` action creates it.
 *
 * Removing a key breaks the images of every mail forwarded while it signed, so keep old keys.
 */
const imageProxyKeysParameter = `/alias/${stage}/image-proxy-keys`;

/**
 * The temp-mail domains (PLAN.md §3.1, §20.22): separate registrable domains, never one of the
 * shared domains (checked at cold start), receive-only. Empty turns temp mail off.
 */
const tempDomains = (process.env.ALIAS_TEMP_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim())
  .filter((domain) => domain.length > 0);
/** Stored mail of inbox aliases and temporary inboxes, sealed (`Envelope` in `@alias/inbox`). */
const inboxBucketName = `alias-inbox-${stage}`;

/**
 * The inbox keys (PLAN.md §20.22.2): they wrap each stored message's data key. Same format,
 * storage and two-step rotation as the reverse-token keys; both the inbound Lambda (wraps) and
 * the API (unwraps) read it. The `Keyring` action creates it.
 *
 * A retired key may be removed 30 days (the longest retention) after it stopped wrapping: no
 * message wrapped with it is left by then. Removing it earlier makes those messages unreadable.
 */
const inboxKeysParameter = `/alias/${stage}/inbox-keys`;

/**
 * The webhook keys (PLAN.md §20.30): they seal the webhook signing secrets at rest. Same format
 * and storage as the other keyrings; the API (seals on create and rotate) and the delivery Lambda
 * (opens) read it. The `Keyring` action creates it.
 *
 * Rotation is the usual two puts (add the new key after the current one, then move it first). A
 * retired key opens every secret sealed with it until each webhook's secret is rotated or the
 * webhook deleted, so keep it until then; removing it earlier stops those webhooks' deliveries
 * (they retry into the dead-letter queue).
 */
const webhookKeysParameter = `/alias/${stage}/webhook-keys`;

/**
 * A deployed stage has its app domain on Cloudflare: its DNS records, the certificate's validation
 * and the Turnstile widget are made here. The `local` stage (typecheck, a scratch account) has no
 * Cloudflare at all: the distribution answers on `*.cloudfront.net` and sign-up uses Turnstile's
 * test keys.
 */
const isOnCloudflare = stage !== "local";

/**
 * Cloudflare Turnstile at sign-up (PLAN.md §20.27). This stack creates the widget (hostname = the
 * app domain, mode "Managed"); its site key is public and goes into the API's configuration (the
 * API names it to the web app), its secret key into the `SecureString` the API reads at cold
 * start. Unlike the keyrings below, the secret is in the Alchemy state: Cloudflare generates it
 * and hands it to whoever reads the widget, so the state holds nothing Cloudflare doesn't.
 *
 * Rotating it in the dashboard keeps the old secret valid for a grace period; deploy again within
 * that period (the parameter is rewritten and the API's containers read it when they start).
 */
const turnstileSecretParameter = `/alias/${stage}/turnstile-secret`;
/** Turnstile's documented always-passing test keys, for the `local` stage. */
const turnstileTestKeys = {
  siteKey: "1x00000000000000000000AA",
  secret: "1x0000000000000000000000000000000AA",
};
/** Sign-ups everyone together may make in an hour before sign-up pauses (the circuit breaker). */
const maxSignupsPerHour = process.env.ALIAS_MAX_SIGNUPS_PER_HOUR ?? "100";

/**
 * The secret CloudFront adds to every request it forwards to the API (PLAN.md §20.26), so the API
 * knows a request came through the distribution (and its WAF) and may trust
 * `CloudFront-Viewer-Address`. A keyring like the others, read by the API at cold start; unlike
 * them, this stack reads it too, at deploy time, because the distribution's origin custom header
 * must carry the current key: the value ends up in the distribution config and the Alchemy state.
 * The `Keyring` action creates it; `OriginSecretHeader` reads it for the header.
 *
 * Rotate in three steps: append the new key (`1:<old>,2:<new>`) and update the API function (any
 * configuration change starts fresh containers that accept both); put it first (`2:<new>,1:<old>`)
 * and deploy, which sends the new key once the distribution has deployed everywhere; then drop the
 * old key and update the API function again.
 */
const originSecretsParameter = `/alias/${stage}/origin-secrets`;

/** The web app's production build (`pnpm --filter @alias/web build`), uploaded on deploy. */
const webBucketName = `alias-web-${stage}`;
const webBuild = new URL("../apps/web/dist", import.meta.url).pathname;

/** Where SES receives mail in eu-west-1 (SES endpoints, "Email receiving"); every MX names it. */
const inboundMx = "inbound-smtp.eu-west-1.amazonaws.com";

/** The monthly cost budget, in USD; mail goes to `ALIAS_ALERT_EMAIL` at 80% and when forecast over. */
const budgetUsd = process.env.ALIAS_BUDGET_USD?.trim() || "20";

/**
 * The Lambda concurrency quota (Service Quotas, "Concurrent executions", L-B99A9384) this stack
 * asks for; `reservedConcurrency` above needs at least 452.
 */
const lambdaConcurrencyQuota = 1000;

/** How long a deploy waits for ACM: validation records appear in seconds, issuance in minutes. */
const certificatePoll = Schedule.max([Schedule.spaced("10 seconds"), Schedule.recurs(90)]);

/** What the certificate actions throw while ACM isn't there yet; retried by `certificatePoll`. */
class CertificatePending extends Schema.TaggedError<CertificatePending>()("CertificatePending", {
  status: Schema.String,
}) {}

/** The keyrings this stack creates (once each, never overwritten) and the functions read. */
const keyringNames = {
  reverseTokenKeys: reverseTokenKeysParameter,
  imageProxyKeys: imageProxyKeysParameter,
  inboxKeys: inboxKeysParameter,
  webhookKeys: webhookKeysParameter,
  originSecrets: originSecretsParameter,
};

/** What a deploy-time AWS call needs, signed with Alchemy's own credentials (its profile). */
const awsCalls = (
  credentials: Effect.Effect<ResolvedCredentials, CredentialsError>,
  region: RegionName,
) =>
  Layer.mergeAll(Layer.succeed(Credentials, credentials), Region.of(region), FetchHttpClient.layer);

/**
 * The work a deploy does that no Alchemy resource models, as Actions: each runs during apply,
 * after the Outputs it takes, and again only when its input changes. They call AWS with the
 * credentials Alchemy deploys with, so a deploy needs no other login.
 */
const deployActions = (credentials: Effect.Effect<ResolvedCredentials, CredentialsError>) => {
  const ssm = awsCalls(credentials, AwsClient.region);
  // CloudFront takes certificates from us-east-1 only.
  const acm = awsCalls(credentials, "us-east-1");
  return {
    /**
     * Creates a keyring parameter with one fresh key (`1:<base64url of 32 random bytes>`,
     * `Keyring.parse` in `@alias/core`) unless it exists. `PutParameter` without `Overwrite`
     * refuses an existing name, so a key is never replaced, rotated ones included. The value is
     * made here and returned nowhere: the Alchemy state holds the name only (the owner's decision).
     * A parameter deleted later comes back only with `--force`.
     */
    Keyring: Alchemy.Action(
      "Keyring",
      Effect.fn(function* (input: { name: string }) {
        yield* SSM.putParameter({
          Name: input.name,
          Type: "SecureString",
          Value: Redacted.make(`1:${randomBytes(32).toString("base64url")}`),
          Description: "Keyring (PLAN.md §20.14), made once by infra/alchemy.run.ts",
        }).pipe(
          Effect.catchTag("ParameterAlreadyExists", () => Effect.void),
          Effect.provide(ssm),
        );
        return { name: input.name };
      }),
    ),
    /**
     * The origin custom header's value: the current origin secret. `version` is the parameter's
     * version seen when planning, so a rotation's "put it first and deploy" runs this again.
     */
    OriginSecretHeader: Alchemy.Action(
      "OriginSecretHeader",
      Effect.fn(function* (input: { name: string; version: number }) {
        const keys = yield* Parameters.keyring(input.name).pipe(Effect.provide(ssm));
        return { header: Redacted.value(OriginSecret.headerValue(keys)) };
      }),
    ),
    /**
     * The app certificate's DNS validation record, once ACM has made it (a few seconds after the
     * request). ACM names it with a trailing dot; Cloudflare wants none.
     */
    CertificateValidationRecord: Alchemy.Action(
      "CertificateValidationRecord",
      Effect.fn(function* (input: { certificateArn: string }) {
        const record = yield* ACM.describeCertificate({
          CertificateArn: input.certificateArn,
        }).pipe(
          Effect.flatMap(({ Certificate }) => {
            const resource = Certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
            return resource === undefined
              ? Effect.fail(new CertificatePending({ status: "no validation record yet" }))
              : Effect.succeed(resource);
          }),
          Effect.retry({ while: P.isTagged("CertificatePending"), schedule: certificatePoll }),
          Effect.provide(acm),
        );
        return { name: record.Name.replace(/\.$/, ""), value: record.Value.replace(/\.$/, "") };
      }),
    ),
    /**
     * Waits until ACM reports the certificate `ISSUED` (CloudFront refuses a pending one), about
     * 15 minutes at most; Cloudflare answers the validation record right away, so it usually takes
     * a few. Later deploys don't wait. Fails on ACM's terminal statuses and when the wait runs
     * out; deploying again resumes it.
     */
    CertificateIssued: Alchemy.Action(
      "CertificateIssued",
      Effect.fn(function* (input: { certificateArn: string; validationRecordId: string }) {
        yield* ACM.describeCertificate({ CertificateArn: input.certificateArn }).pipe(
          Effect.flatMap(({ Certificate }) => {
            const status = Certificate?.Status ?? "unknown";
            if (status === "ISSUED") return Effect.void;
            return status === "PENDING_VALIDATION"
              ? Effect.fail(new CertificatePending({ status }))
              : Effect.die(new Error(`ACM certificate ${input.certificateArn} is ${status}`));
          }),
          Effect.retry({ while: P.isTagged("CertificatePending"), schedule: certificatePoll }),
          Effect.provide(acm),
        );
        return { certificateArn: input.certificateArn };
      }),
    ),
  };
};

/**
 * The CloudFront Function on the app's viewer requests: paths without a file extension are the
 * SPA's client-side routes (`/aliases`, `/oauth/authorize`, `/device`) and get `index.html`; the
 * API's paths have their own behaviors and never reach it. A custom error response can't do
 * this: it would also replace the API's own 403 and 404 answers.
 */
const spaRoutesCode = `function handler(event) {
  var request = event.request;
  var last = request.uri.substring(request.uri.lastIndexOf("/") + 1);
  if (last.indexOf(".") === -1) request.uri = "/index.html";
  return request;
}`;

/**
 * The CloudFront Function on viewer responses of the app and the API: the security headers
 * (`@alias/web/security-headers`, the ones the browser tests run under). A function, not a
 * response headers policy: the flat-rate Free and Pro plans allow only managed policies, and the
 * managed SecurityHeadersPolicy has no CSP. The image proxy sets its own (sandbox CSP, `nosniff`).
 */
const securityHeadersCode = `var HEADERS = ${JSON.stringify(securityHeaders())};
function handler(event) {
  var headers = event.response.headers;
  Object.keys(HEADERS).forEach(function (name) {
    headers[name] = { value: HEADERS[name] };
  });
  return event.response;
}`;

/** Paths whose requests WAF counts separately: sign-up, login, OAuth and device login. */
const authPaths = ["/v1/auth/", "/v1/oauth/", "/v1/device/"];

/** A WAF statement matching request paths that start with `prefix`. */
const pathStartsWith = (prefix: string) => ({
  ByteMatchStatement: {
    SearchString: new TextEncoder().encode(prefix),
    FieldToMatch: { UriPath: {} },
    PositionalConstraint: "STARTS_WITH" as const,
    TextTransformations: [{ Priority: 0, Type: "NONE" as const }],
  },
});

const visibility = (name: string) => ({
  SampledRequestsEnabled: true,
  CloudWatchMetricsEnabled: true,
  MetricName: `alias-${stage}-${name}`,
});

/** An AWS managed rule group, its own actions (block) unchanged. */
const managedRules = (name: string, priority: number) => ({
  Name: name,
  Priority: priority,
  Statement: { ManagedRuleGroupStatement: { VendorName: "AWS", Name: name } },
  OverrideAction: { None: {} },
  VisibilityConfig: visibility(name),
});

/**
 * The web ACL's rules (PLAN.md §20.26), five at most so the flat-rate Free plan fits: AWS's IP
 * reputation and known-bad-inputs groups, and two rate rules per viewer IP over 5 minutes as a
 * second layer to the app's own limits. Left out on purpose: the core rule set (it blocks bodies
 * over 8 KB, HTML and URLs in bodies, and long URI paths, so drafts, OpenPGP keys and image proxy
 * URLs would trip it; the API decodes every payload with a schema and renders no HTML), the
 * anonymous IP list (it blocks VPNs and Tor, which privacy users rely on), and a rate rule on
 * `/img/*` (Gmail and Apple Mail fetch images for all their users from a few addresses).
 */
const wafRules = [
  managedRules("AWSManagedRulesAmazonIpReputationList", 0),
  managedRules("AWSManagedRulesKnownBadInputsRuleSet", 1),
  {
    Name: "auth-rate",
    Priority: 2,
    // Logins take two requests; `alias login` polls the token endpoint every 5 s (60 in 5 min).
    Statement: {
      RateBasedStatement: {
        Limit: 300,
        EvaluationWindowSec: 300,
        AggregateKeyType: "IP" as const,
        ScopeDownStatement: { OrStatement: { Statements: authPaths.map(pathStartsWith) } },
      },
    },
    Action: { Block: {} },
    VisibilityConfig: visibility("auth-rate"),
  },
  {
    Name: "flood-rate",
    Priority: 3,
    Statement: {
      RateBasedStatement: {
        Limit: 3000,
        EvaluationWindowSec: 300,
        AggregateKeyType: "IP" as const,
        ScopeDownStatement: { NotStatement: { Statement: pathStartsWith("/img/") } },
      },
    },
    Action: { Block: {} },
    VisibilityConfig: visibility("flood-rate"),
  },
];

/**
 * @public The stack Alchemy loads.
 *
 * Logical IDs must be unique across resource types: Alchemy keys resources by ID alone and hands
 * a second registration of an ID the first resource back, whatever its type (`Resource.ts`).
 */
export default Alchemy.Stack(
  "alias",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
    state: stage === "local" ? localState() : AWS.state(),
  },
  Effect.gen(function* () {
    const { accountId, credentials, region } = yield* AWS.AWSEnvironment.current;
    // Every ARN, the MX target and SES receiving below are eu-west-1's. An `aws login` profile's
    // own region wins over AWS_REGION, so a profile set to another region must stop the deploy.
    if (region !== AwsClient.region) {
      return yield* Effect.die(
        new Error(
          `Alchemy's AWS region is ${region}, not ${AwsClient.region}: set it on the profile (\`pnpm infra:aws configure set region ${AwsClient.region} --profile <name>\`).`,
        ),
      );
    }
    const { Keyring, OriginSecretHeader, CertificateValidationRecord, CertificateIssued } =
      deployActions(credentials);
    // Reservations need room: Lambda keeps 100 unreserved, so the applied quota must cover the sum
    // plus 100 (`lambdaConcurrencyQuota`, the request below). Until AWS grants it (a new account
    // starts at 10, and a request may wait days for a support case), the functions deploy without
    // reservations, uncapped within the small quota; the first deploy after the grant adds them.
    const neededConcurrency = Object.values(reservedConcurrency).reduce<number>(
      (sum, n) => sum + n,
      100,
    );
    const appliedConcurrency = yield* ServiceQuotas.getServiceQuota({
      ServiceCode: "lambda",
      QuotaCode: "L-B99A9384",
    }).pipe(
      Effect.map(({ Quota }) => Quota?.Value ?? 0),
      Effect.provide(awsCalls(credentials, AwsClient.region)),
      Effect.orDie,
    );
    const hasConcurrencyRoom = appliedConcurrency >= neededConcurrency;
    if (!hasConcurrencyRoom) {
      yield* Effect.logWarning(
        `Lambda concurrency quota is ${appliedConcurrency}, reservations need ${neededConcurrency}: deploying without reserved concurrency until the increase is granted (PLAN.md §20.29, §20.37).`,
      );
    }
    const reserve = (count: number) =>
      hasConcurrencyRoom ? { reservedConcurrentExecutions: count } : {};

    // The keyrings (above). The functions take their names from these Outputs, so none starts
    // before its keys exist.
    const keyrings = {
      reverseTokenKeys: yield* Keyring("ReverseTokenKeys", { name: keyringNames.reverseTokenKeys }),
      imageProxyKeys: yield* Keyring("ImageProxyKeys", { name: keyringNames.imageProxyKeys }),
      inboxKeys: yield* Keyring("InboxKeys", { name: keyringNames.inboxKeys }),
      webhookKeys: yield* Keyring("WebhookKeys", { name: keyringNames.webhookKeys }),
      originSecrets: yield* Keyring("OriginSecrets", { name: keyringNames.originSecrets }),
    };
    // Built from the fixed name so the policy is a plain string (Outputs can't be templated here).
    const tableArn = `arn:aws:dynamodb:eu-west-1:${accountId}:table/${tableName}`;
    const spoolObjects = `arn:aws:s3:::${spoolBucketName}/${spoolPrefix}*`;
    // Sending through a configuration set is authorized on the set as well as on the identity.
    // A name with a leading slash has no extra slash in its ARN.
    const reverseTokenKeysParameterArn = `arn:aws:ssm:eu-west-1:${accountId}:parameter${reverseTokenKeysParameter}`;
    const imageProxyKeysParameterArn = `arn:aws:ssm:eu-west-1:${accountId}:parameter${imageProxyKeysParameter}`;
    const inboxKeysParameterArn = `arn:aws:ssm:eu-west-1:${accountId}:parameter${inboxKeysParameter}`;
    const webhookKeysParameterArn = `arn:aws:ssm:eu-west-1:${accountId}:parameter${webhookKeysParameter}`;
    const turnstileSecretParameterArn = `arn:aws:ssm:eu-west-1:${accountId}:parameter${turnstileSecretParameter}`;
    const originSecretsParameterArn = `arn:aws:ssm:eu-west-1:${accountId}:parameter${originSecretsParameter}`;
    const inboxObjects = `arn:aws:s3:::${inboxBucketName}/*`;
    const configurationSetArn = `arn:aws:ses:eu-west-1:${accountId}:configuration-set/${configurationSetName}`;
    // The receipt rule, built from its fixed names: the bucket policy and the Lambda permission
    // both name it, and SES checks both when the rule is created, before it exists. The format is
    // the one the SES receiving docs give for these conditions.
    const receiptRuleArn = `arn:aws:ses:eu-west-1:${accountId}:receipt-rule-set/${receiptRuleSetName}:receipt-rule/${receiptRuleName}`;

    const identityArn = (name: string) => `arn:aws:ses:eu-west-1:${accountId}:identity/${name}`;
    const domainIdentityStatements = [
      {
        Effect: "Allow" as const,
        Action: [
          "ses:CreateEmailIdentity",
          "ses:GetEmailIdentity",
          "ses:DeleteEmailIdentity",
          "ses:PutEmailIdentityMailFromAttributes",
          "ses:PutEmailIdentityFeedbackAttributes",
        ],
        Resource: identityArn("*"),
      },
      {
        Effect: "Deny" as const,
        Action: [
          "ses:CreateEmailIdentity",
          "ses:DeleteEmailIdentity",
          "ses:PutEmailIdentityMailFromAttributes",
          "ses:PutEmailIdentityFeedbackAttributes",
        ],
        // The temp-mail domains are the service's too (PLAN.md §20.25).
        Resource: [...sharedDomains, ...tempDomains].flatMap((domain) => [
          identityArn(domain),
          identityArn(`*.${domain}`),
        ]),
      },
    ];

    const table = yield* AWS.DynamoDB.Table("Data", {
      tableName,
      partitionKey: Table.spec.partitionKey,
      sortKey: Table.spec.sortKey,
      attributes: { ...Table.spec.attributes },
      globalSecondaryIndexes: Table.spec.globalSecondaryIndexes.map((index) => ({
        indexName: index.indexName,
        partitionKey: index.partitionKey,
        sortKey: index.sortKey,
        projection: { ProjectionType: "ALL" as const },
      })),
      billingMode: "PAY_PER_REQUEST",
      // 7 days, not the default 35: erased accounts stay restorable only that long. After a
      // restore, the erasure journal (`AccountRepo`, TTL 8 days) names whose erasure to re-apply
      // (PLAN.md §20.15).
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
        recoveryPeriod: Duration.days(7),
      },
      timeToLiveSpecification: { AttributeName: Table.spec.timeToLiveAttribute, Enabled: true },
      // A deployed stage's table can't be deleted by a mistaken destroy (PLAN.md §20.25).
      deletionProtectionEnabled: stage !== "local",
    });

    // Raw inbound mail. SES writes it and processing deletes it; the lifecycle rule expires anything
    // processing misses.
    const spool = yield* AWS.S3.Bucket("Spool", {
      bucketName: spoolBucketName,
      lifecycleRules: [
        {
          ID: "expire-inbound",
          Status: "Enabled",
          Filter: { Prefix: spoolPrefix },
          // Lambda may retry an event for 6 hours, and one it gave up on waits in the async
          // failures queue for a redrive (PLAN.md §20.29), which needs the message still here.
          Expiration: { Days: 3 },
        },
      ],
      policy: [
        {
          Effect: "Allow",
          Sid: "AllowSESPuts",
          Principal: { Service: "ses.amazonaws.com" },
          Action: ["s3:PutObject"],
          Resource: spoolObjects,
          // Only SES acting for this account's receipt rule, not another account's or rule's.
          Condition: {
            StringEquals: { "aws:SourceAccount": accountId, "aws:SourceArn": receiptRuleArn },
          },
        },
        {
          Effect: "Deny",
          Sid: "TlsOnly",
          Principal: "*",
          Action: ["s3:*"],
          Resource: [`arn:aws:s3:::${spoolBucketName}`, `arn:aws:s3:::${spoolBucketName}/*`],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        },
      ],
    });

    // Stored mail (PLAN.md §20.22.2). Each retention class is a key prefix with its own
    // expiration; the message metadata in DynamoDB expires (TTL) at the same time and holds the
    // only wrapped data key, so a body S3 has yet to delete can't be decrypted. Private, SSE-S3
    // on top of our own encryption, TLS only.
    yield* AWS.S3.Bucket("Inbox", {
      bucketName: inboxBucketName,
      lifecycleRules: RetentionDays.literals.map((days) => ({
        ID: `expire-${days}d`,
        Status: "Enabled" as const,
        Filter: { Prefix: Inbox.classPrefix(days) },
        Expiration: { Days: days },
      })),
      policy: [
        {
          Effect: "Deny",
          Sid: "TlsOnly",
          Principal: "*",
          Action: ["s3:*"],
          Resource: [`arn:aws:s3:::${inboxBucketName}`, inboxObjects],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        },
      ],
    });
    const inboxKeys = {
      Effect: "Allow" as const,
      Action: ["ssm:GetParameter"],
      Resource: inboxKeysParameterArn,
    };
    const webhookKeys = {
      Effect: "Allow" as const,
      Action: ["ssm:GetParameter"],
      Resource: webhookKeysParameterArn,
    };

    // Logs carry no addresses or content, but still expire (PLAN.md §20.15): without a retention
    // Lambda's log groups never do.
    // Every function's logs expire (PLAN.md §20.15); Lambda's default keeps them forever.
    const logging = { retention: Duration.days(14) };

    // Webhook jobs: the API, the inbound and the feedback Lambda send one message per event and
    // subscribed endpoint; the delivery Lambda signs and posts them. Failures back off with
    // ChangeMessageVisibility and, after the last attempt, land in the dead-letter queue, kept for
    // the maximum 14 days. The delivery Lambda runs at most 30 s; the visibility timeout is six
    // times that, as the Lambda SQS docs recommend (`WebhookQueue.settings`).
    const webhookQueueArn = `arn:aws:sqs:eu-west-1:${accountId}:${webhookQueueName}`;
    const webhookDeadLetters = yield* AWS.SQS.Queue("WebhookDeadLetters", {
      queueName: `${webhookQueueName}-dlq`,
      messageRetentionPeriod: Duration.days(14),
      sqsManagedSseEnabled: true,
    });
    const webhookQueue = yield* AWS.SQS.Queue("Webhooks", {
      queueName: webhookQueueName,
      visibilityTimeout: Duration.seconds(WebhookQueue.settings.visibilityTimeoutSeconds),
      // Longer than the whole retry schedule (about 28 hours).
      messageRetentionPeriod: Duration.days(4),
      redrivePolicy: {
        deadLetterTargetArn: webhookDeadLetters.queueArn,
        maxReceiveCount: WebhookQueue.settings.maxReceiveCount,
      },
      sqsManagedSseEnabled: true,
    });
    /** Producers only enqueue. */
    const publishWebhooks = {
      Effect: "Allow" as const,
      Action: ["sqs:SendMessage"],
      Resource: webhookQueueArn,
    };

    // Where Lambda puts async events (SES mail, SNS feedback) it gave up on, so they aren't lost
    // silently (PLAN.md §20.29). An alarm fires on the first one.
    const asyncFailures = yield* AWS.SQS.Queue("AsyncFailures", {
      queueName: asyncFailuresQueueName,
      messageRetentionPeriod: Duration.days(14),
      sqsManagedSseEnabled: true,
    });
    /** Lambda sends an on-failure record with the function's own role. */
    const sendAsyncFailures = {
      Effect: "Allow" as const,
      Action: ["sqs:SendMessage"],
      Resource: `arn:aws:sqs:eu-west-1:${accountId}:${asyncFailuresQueueName}`,
    };
    /**
     * Lambda's async retries: two after a function error, and throttled events kept for the
     * longest age it allows (6 hours), then recorded in the async failures queue.
     */
    const asyncInvokes = {
      maximumRetryAttempts: 2,
      maximumEventAge: "6 hours",
      destinationConfig: { OnFailure: { Destination: asyncFailures.queueArn } },
    } as const;

    // The Cloudflare zone of each of the service's domains (the domain itself or a parent), looked
    // up by name with the token's account (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`).
    const zoneIds = new Map<string, string>();
    if (isOnCloudflare) {
      const { accountId: cloudflareAccount } = yield* yield* Cloudflare.CloudflareEnvironment;
      yield* Effect.forEach([...sharedDomains, ...tempDomains], (domain) =>
        Cloudflare.Zone.resolveZoneId({
          accountId: cloudflareAccount,
          zone: undefined,
          hostname: domain,
        }).pipe(
          Effect.map((zoneId) => zoneIds.set(domain, zoneId)),
          // A domain without a zone in this account can't be served: stop before anything changes.
          Effect.orDie,
        ),
      );
    }
    const zoneOf = (domain: string) => zoneIds.get(domain) ?? "";

    // Sign-up's human check (PLAN.md §20.27): the widget, and its secret where the API reads it.
    const turnstile = isOnCloudflare
      ? yield* Cloudflare.Turnstile.Widget("Signup", {
          name: `alias-${stage}`,
          domains: [appDomain],
          mode: "managed",
        })
      : undefined;
    yield* AWS.SSM.Parameter("TurnstileSecret", {
      name: turnstileSecretParameter,
      type: "SecureString",
      value: turnstile?.secret ?? Redacted.make(turnstileTestKeys.secret),
      description: "Turnstile secret key for sign-up (PLAN.md §20.27)",
    });

    const api = yield* AWS.Lambda.Function("Api", {
      main: new URL("../apps/api/src/handler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 256,
      // Lambda's default of 3 s is too short for erasing an account with many aliases; the sweep
      // is resumable, but each retry costs the user a passkey prompt.
      timeout: Duration.seconds(30),
      logging,
      ...reserve(reservedConcurrency.api),
      functionUrl: true,
      env: {
        ALIAS_TABLE_NAME: table.tableName,
        ALIAS_RP_ID: appDomain,
        ALIAS_WEB_ORIGIN: `https://${appDomain}`,
        ALIAS_SHARED_DOMAINS: sharedDomains.join(","),
        ALIAS_CONFIRMATION_FROM: confirmationSender,
        ALIAS_SES_CONFIGURATION_SET: configurationSetName,
        // No ALIAS_WEBHOOK_ALLOW_LOOPBACK: webhook URLs must be https on public addresses.
        ALIAS_WEBHOOK_QUEUE_URL: webhookQueue.queueUrl,
        ALIAS_DOH_URL: dohUrl,
        ALIAS_TEMP_DOMAINS: tempDomains.join(","),
        ALIAS_INBOX_BUCKET: inboxBucketName,
        ALIAS_INBOX_KEYS_PARAMETER: keyrings.inboxKeys.name,
        ALIAS_WEBHOOK_KEYS_PARAMETER: keyrings.webhookKeys.name,
        // Mints the reverse alias of a contact the owner adds (PLAN.md §20.33).
        ALIAS_REVERSE_TOKEN_KEYS_PARAMETER: keyrings.reverseTokenKeys.name,
        ALIAS_TURNSTILE_SITE_KEY: turnstile?.sitekey ?? turnstileTestKeys.siteKey,
        ALIAS_TURNSTILE_SECRET_PARAMETER: turnstileSecretParameter,
        ALIAS_MAX_SIGNUPS_PER_HOUR: maxSignupsPerHour,
        // Only requests through the distribution are served (PLAN.md §20.26).
        ALIAS_ORIGIN_SECRETS_PARAMETER: keyrings.originSecrets.name,
      },
    });
    // Sign-up's Turnstile secret, read at cold start.
    yield* api.bind("TurnstileSecret", {
      policyStatements: [
        { Effect: "Allow", Action: ["ssm:GetParameter"], Resource: turnstileSecretParameterArn },
      ],
    });
    // The reverse-token keys, to mint a contact's reverse alias (same `aws/ssm` key, no KMS grant).
    yield* api.bind("ReverseTokenKeys", {
      policyStatements: [
        { Effect: "Allow", Action: ["ssm:GetParameter"], Resource: reverseTokenKeysParameterArn },
      ],
    });
    yield* api.bind("OriginSecrets", {
      policyStatements: [
        { Effect: "Allow", Action: ["ssm:GetParameter"], Resource: originSecretsParameterArn },
      ],
    });
    // Stored mail: read, delete one, and list an alias's objects to purge them with the alias or
    // the account (ListBucket also makes a missing key a 404, not a 403). The inbox keys unwrap.
    yield* api.bind("Inbox", {
      policyStatements: [
        { Effect: "Allow", Action: ["s3:GetObject", "s3:DeleteObject"], Resource: inboxObjects },
        { Effect: "Allow", Action: ["s3:ListBucket"], Resource: `arn:aws:s3:::${inboxBucketName}` },
        inboxKeys,
      ],
    });
    // Publishing events, and sealing endpoint secrets with the webhook keys.
    yield* api.bind("PublishWebhooks", { policyStatements: [publishWebhooks, webhookKeys] });
    yield* api.bind("DataAccess", {
      policyStatements: [
        {
          Effect: "Allow",
          // TransactWriteItems is authorized per item through these actions.
          Action: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:ConditionCheckItem",
            "dynamodb:Query",
          ],
          Resource: [tableArn, `${tableArn}/index/*`],
        },
      ],
    });
    // Forwarding-address confirmations, sent from the app domain's verified identity only.
    yield* api.bind("SendConfirmations", {
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["ses:SendEmail", "ses:SendRawEmail"],
          Resource: [identityArn(appDomain), configurationSetArn],
        },
        {
          // Re-adding a bounced address takes it off the suppression list once (§20.11); mail the
          // owner writes is refused for an address on it (§20.33). Neither action takes a
          // resource-level permission.
          Effect: "Allow",
          Action: ["ses:DeleteSuppressedDestination", "ses:GetSuppressedDestination"],
          Resource: "*",
        },
      ],
    });

    // Custom domains (PLAN.md §20.18): the API creates, reads and deletes their SES identities, and
    // the verification cron reads them (and recreates one an interrupted claim left without).
    // Identities are created at run time, so the grant names every identity in this account; the
    // deny keeps both Lambdas from touching the shared domains' identities (Get stays allowed).
    yield* api.bind("DomainIdentities", { policyStatements: domainIdentityStatements });

    // What `Transport.ses` (`@alias/aws`) needs: SESv2 `SendEmail` with raw content. Both actions,
    // as Alchemy's own `SES.SendEmail` binding grants for raw sends. Forwarded mail and replies go
    // out from aliases on the shared domains, users' subdomains (covered by the shared domain's
    // identity) and verified custom domains (PLAN.md §20.18.2). Custom identities are created at
    // run time, so the resource is every identity of this account: all of them are the service's
    // own, SES refuses unverified ones, and the pipeline sends only from aliases on a domain that
    // is verified and owned by the alias's owner. IAM can't narrow it further without naming the
    // domains (identity tags would need SendEmail to support `aws:ResourceTag`, unverified).
    const sendFromAliasDomains = {
      Effect: "Allow" as const,
      Sid: "SendFromAliasDomains",
      Action: ["ses:SendEmail", "ses:SendRawEmail"],
      Resource: [identityArn("*"), configurationSetArn],
    };
    // Temp-mail domains are receive-only (PLAN.md §20.22.2): `identity/*` above would cover them,
    // so an explicit deny keeps a bug from sending as one.
    const denySendFromTempDomains =
      tempDomains.length > 0
        ? [
            {
              Effect: "Deny" as const,
              Sid: "NoSendFromTempDomains",
              Action: ["ses:SendEmail", "ses:SendRawEmail"],
              Resource: tempDomains.flatMap((domain) => [
                identityArn(domain),
                identityArn(`*.${domain}`),
              ]),
            },
          ]
        : [];
    // Drafts an MCP client wrote go out from the API when their owner sends them in the web app
    // (PLAN.md §20.24): from an alias, to one of its contacts, like a reply.
    yield* api.bind("SendDrafts", {
      policyStatements: [sendFromAliasDomains, ...denySendFromTempDomains],
    });

    // The image proxy (`apps/image-proxy`, PLAN.md §20.19): its own function and role, because it
    // fetches URLs that come from mail. The role can read its keys and its own fetch budgets
    // (§20.29) and nothing else: no other item of the table, no spool, no SES. Reserved
    // concurrency caps what a flood of uncached proxy URLs can cost. The function URL takes only
    // CloudFront's signed requests (OAC with `AWS_IAM`), so every request goes through the cache.
    const imageProxy = yield* AWS.Lambda.Function("ImageProxy", {
      main: new URL("../apps/image-proxy/src/handler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 256,
      logging,
      // The fetch has a 5 s deadline (`Proxy.limits`).
      timeout: Duration.seconds(10),
      ...reserve(reservedConcurrency.imageProxy),
      functionUrl: { authType: "AWS_IAM" },
      env: {
        ALIAS_IMAGE_PROXY_KEYS_PARAMETER: keyrings.imageProxyKeys.name,
        ALIAS_TABLE_NAME: table.tableName,
      },
    });
    yield* imageProxy.bind("ImageProxyKeys", {
      policyStatements: [
        { Effect: "Allow", Action: ["ssm:GetParameter"], Resource: imageProxyKeysParameterArn },
      ],
    });
    // Budgets and down origins (`ProxyRepo`): single-item reads and writes, and only of items
    // whose partition key starts with `PROXY#` (the DynamoDB IAM docs' fine-grained access).
    yield* imageProxy.bind("ProxyBudgets", {
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          Resource: [tableArn],
          Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PROXY#*"] } },
        },
      ],
    });
    const imageProxyAccess = yield* AWS.CloudFront.OriginAccessControl("ImageProxyAccess", {
      originType: "lambda",
      signingBehavior: "always",
      signingProtocol: "sigv4",
    });
    const functionUrlHost = (url: string | undefined) =>
      new URL(url ?? "https://missing.invalid").hostname;

    // The web app: a private bucket that only this distribution reads (OAC), with the build's
    // hashed assets cached for a year and everything else (`index.html`) revalidated each time.
    const web = yield* AWS.S3.Bucket("Web", { bucketName: webBucketName });
    yield* AWS.Website.AssetDeployment("WebAssets", {
      bucket: web,
      sourcePath: webBuild,
      purge: true,
      fileOptions: [
        { files: "assets/**", cacheControl: "public, max-age=31536000, immutable" },
        { files: "**", cacheControl: "no-cache" },
      ],
    });
    const webAccess = yield* AWS.CloudFront.OriginAccessControl("WebAccess", {
      originType: "s3",
      signingBehavior: "always",
      signingProtocol: "sigv4",
    });

    // What the API's origin custom header carries: the current origin secret, read now.
    // Its version now (0 before the first deploy made it), so a rotation re-reads it.
    const originSecretsVersion = yield* Parameters.secureString(originSecretsParameter).pipe(
      Effect.map(({ version }) => version),
      Effect.catchTag("MissingParameter", () => Effect.succeed(0)),
      Effect.provide(awsCalls(credentials, AwsClient.region)),
      Effect.orDie,
    );
    const originSecret = yield* OriginSecretHeader({
      name: keyrings.originSecrets.name,
      version: originSecretsVersion,
    });

    const spaRoutes = yield* AWS.CloudFront.Function("SpaRoutes", {
      comment: "SPA routes to index.html (PLAN.md §20.26)",
      code: spaRoutesCode,
    });
    const headers = yield* AWS.CloudFront.Function("SecurityHeaders", {
      comment: "Security headers of the app origin (PLAN.md §20.26)",
      code: securityHeadersCode,
    });
    const withHeaders = [
      { functionArn: headers.functionArn, eventType: "viewer-response" as const },
    ];

    // The app domain's certificate (ACM, us-east-1), validated through a CNAME in Cloudflare that
    // stays there for renewals. The distribution takes it once ACM has issued it.
    const certificate = yield* AWS.ACM.Certificate("AppCertificate", { domainName: appDomain });
    const issuedCertificate = isOnCloudflare
      ? yield* Effect.gen(function* () {
          const validation = yield* CertificateValidationRecord({
            certificateArn: certificate.certificateArn,
          });
          const validationRecord = yield* Cloudflare.DNS.Record("CertificateValidation", {
            zoneId: zoneOf(appDomain),
            name: validation.name,
            type: "CNAME",
            content: validation.value,
            comment: "ACM validation of the app certificate (PLAN.md §20.26); keep for renewals",
          });
          return yield* CertificateIssued({
            certificateArn: certificate.certificateArn,
            // Unused by the wait; naming it makes the wait start once the record exists.
            validationRecordId: validationRecord.recordId,
          });
        })
      : undefined;
    const firewall = yield* AWS.WAFv2.WebACL("AppFirewall", {
      scope: "CLOUDFRONT",
      // WAF allows letters, digits, whitespace and `+=:#@/-,.` here: no `§`, no parentheses.
      description: `alias ${stage}: managed rules and rate limits, PLAN.md 20.26`,
      defaultAction: { Allow: {} },
      rules: wafRules,
      visibilityConfig: visibility("acl"),
    });

    // The API's behaviors: never cached; every viewer header but Host (function URLs expect
    // their own) plus CloudFront's, among them CloudFront-Viewer-Address; every method.
    const toApi = {
      targetOriginId: "api",
      viewerProtocolPolicy: "redirect-to-https" as const,
      allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: AWS.CloudFront.MANAGED_CACHING_DISABLED_POLICY_ID,
      originRequestPolicyId: AWS.CloudFront.MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
      functionAssociations: withHeaders,
    };

    // One distribution for the app's origin (PLAN.md §20.26): a flat-rate plan covers exactly
    // one, and the app, the API (passkeys, the OAuth issuer) and the image proxy share a domain.
    // Five behaviors, the Free plan's maximum. The API stays behind its public function URL
    // because OAC can't sign POST bodies for browsers; the origin secret stands in for it.
    const app = yield* AWS.CloudFront.Distribution("AppDistribution", {
      comment: `alias (${stage})`,
      ...(issuedCertificate !== undefined
        ? {
            aliases: [appDomain],
            viewerCertificate: {
              acmCertificateArn: issuedCertificate.certificateArn,
              sslSupportMethod: "sni-only" as const,
              minimumProtocolVersion: "TLSv1.2_2021" as const,
            },
          }
        : {}),
      priceClass: "PriceClass_100",
      httpVersion: "http2and3",
      webAclId: firewall.webAclArn,
      origins: [
        {
          id: "web",
          domainName: web.bucketRegionalDomainName,
          s3Origin: true,
          originAccessControlId: webAccess.originAccessControlId,
        },
        {
          id: "api",
          domainName: Output.map(functionUrlHost)(api.functionUrl),
          customOriginConfig: { originProtocolPolicy: "https-only" },
          // What tells the API a request came through here (above).
          customHeaders: { [CloudFront.ORIGIN_SECRET_HEADER]: originSecret.header },
          // The API Lambda runs up to 30 s (erasure); CloudFront's default waits 30 s too.
          responseCompletionTimeout: "35 seconds",
        },
        {
          id: "image-proxy",
          domainName: Output.map(functionUrlHost)(imageProxy.functionUrl),
          originAccessControlId: imageProxyAccess.originAccessControlId,
          customOriginConfig: { originProtocolPolicy: "https-only" },
        },
      ],
      defaultCacheBehavior: {
        targetOriginId: "web",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        // Honours the objects' Cache-Control (above).
        cachePolicyId: AWS.CloudFront.MANAGED_CACHING_OPTIMIZED_POLICY_ID,
        functionAssociations: [
          { functionArn: spaRoutes.functionArn, eventType: "viewer-request" },
          ...withHeaders,
        ],
      },
      orderedCacheBehaviors: [
        { ...toApi, pathPattern: "/v1/*" },
        // MCP and its OAuth metadata (PLAN.md §20.24); `/oauth/authorize` is the app's page.
        { ...toApi, pathPattern: "/mcp" },
        { ...toApi, pathPattern: "/.well-known/*" },
        {
          // CachingOptimized keys the cache on the path alone and forwards no cookies, query or
          // viewer headers, and honours the Lambda's `Cache-Control` (a day for images). The
          // proxy sets its own security headers, so no function here.
          pathPattern: "/img/*",
          targetOriginId: "image-proxy",
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: ["GET", "HEAD"],
          cachedMethods: ["GET", "HEAD"],
          compress: false,
          cachePolicyId: AWS.CloudFront.MANAGED_CACHING_OPTIMIZED_POLICY_ID,
        },
      ],
    });
    // Only this distribution reads the web bucket, and only over TLS. One policy, bound once the
    // distribution exists (the bucket is its origin, so its ARN can't be in the bucket's props).
    yield* web.bind("CloudFrontReads", {
      policyStatements: [
        {
          Effect: "Deny",
          Sid: "TlsOnly",
          Principal: "*",
          Action: ["s3:*"],
          Resource: [`arn:aws:s3:::${webBucketName}`, `arn:aws:s3:::${webBucketName}/*`],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        },
        {
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: ["s3:GetObject"],
          Resource: `arn:aws:s3:::${webBucketName}/*`,
          Condition: { StringEquals: { "AWS:SourceArn": app.distributionArn } },
        },
      ],
    });
    // OAC needs both: `InvokeFunctionUrl` for the URL and `InvokeFunction` for the call behind it,
    // each only for this distribution.
    yield* Effect.forEach(
      [
        { id: "CloudFrontInvokesImageProxyUrl", action: "lambda:InvokeFunctionUrl" },
        { id: "CloudFrontInvokesImageProxy", action: "lambda:InvokeFunction" },
      ],
      ({ id, action }) =>
        AWS.Lambda.Permission(id, {
          action,
          functionName: imageProxy.functionName,
          principal: "cloudfront.amazonaws.com",
          sourceArn: app.distributionArn,
          ...(action === "lambda:InvokeFunctionUrl"
            ? { functionUrlAuthType: "AWS_IAM" as const }
            : { invokedViaFunctionUrl: true }),
        }),
    );
    // Proxied images point at the app domain; on the `local` stage, which has none, at the
    // distribution's own name.
    const appOrigin = isOnCloudflare
      ? Output.interpolate`https://${appDomain}`
      : Output.interpolate`https://${app.domainName}`;

    // The inbound pipeline (`apps/inbound`), invoked by the receipt rule below. Raw mail is held in
    // memory (SES accepts up to 40 MB) and rewritten once, hence the memory size.
    const inbound = yield* AWS.Lambda.Function("Inbound", {
      main: new URL("../apps/inbound/src/handler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 512,
      timeout: Duration.seconds(60),
      logging,
      functionUrl: false,
      ...reserve(reservedConcurrency.inbound),
      // The pipeline's claims make retries safe (PLAN.md §20.6); what Lambda gives up on is
      // recorded, not dropped (§20.29).
      eventInvokeConfig: asyncInvokes,
      env: {
        ALIAS_TABLE_NAME: table.tableName,
        ALIAS_SPOOL_BUCKET: spool.bucketName,
        ALIAS_SHARED_DOMAINS: sharedDomains.join(","),
        ALIAS_REVERSE_TOKEN_KEYS_PARAMETER: keyrings.reverseTokenKeys.name,
        ALIAS_WEBHOOK_QUEUE_URL: webhookQueue.queueUrl,
        ALIAS_IMAGE_PROXY_URL: appOrigin,
        ALIAS_IMAGE_PROXY_KEYS_PARAMETER: keyrings.imageProxyKeys.name,
        ALIAS_SES_CONFIGURATION_SET: configurationSetName,
        ALIAS_TEMP_DOMAINS: tempDomains.join(","),
        ALIAS_INBOX_BUCKET: inboxBucketName,
        ALIAS_INBOX_KEYS_PARAMETER: keyrings.inboxKeys.name,
      },
    });
    // Inbox mode and kept failed deliveries (§20.33): put a sealed body, and delete it again when
    // its alias vanished meanwhile.
    yield* inbound.bind("Inbox", {
      policyStatements: [
        { Effect: "Allow", Action: ["s3:PutObject", "s3:DeleteObject"], Resource: inboxObjects },
        inboxKeys,
      ],
    });
    // Least privilege: aliases, recipients and contacts are read by key or one partition Query;
    // counters, quotas, delivery claims and sent records (§20.28) are single-item writes. A new
    // contact and its id are
    // one TransactWriteItems, which IAM authorizes per item: PutItem for the two items, and
    // ConditionCheckItem for the check that their alias still exists (PLAN.md §20.15). No index.
    yield* inbound.bind("DataAccess", {
      policyStatements: [
        {
          Effect: "Allow",
          Action: [
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:ConditionCheckItem",
          ],
          Resource: [tableArn],
        },
      ],
    });
    // Read (GetObject also authorizes HeadObject, the size check) and delete spooled mail. S3
    // answers a missing key with 404 only to callers allowed to list the bucket and with 403 to
    // everyone else, so without ListBucket a message processed earlier would look like a spool
    // failure and be retried instead of dropped as gone (S3 HeadObject/GetObject docs).
    yield* inbound.bind("Spool", {
      policyStatements: [
        { Effect: "Allow", Action: ["s3:GetObject", "s3:DeleteObject"], Resource: spoolObjects },
        { Effect: "Allow", Action: ["s3:ListBucket"], Resource: `arn:aws:s3:::${spoolBucketName}` },
      ],
    });
    yield* inbound.bind("SendMail", {
      policyStatements: [sendFromAliasDomains, ...denySendFromTempDomains],
    });
    yield* inbound.bind("PublishWebhooks", { policyStatements: [publishWebhooks] });
    // Replies to an address on the suppression list are refused, not sent (PLAN.md §20.33).
    yield* inbound.bind("SuppressionCheck", {
      policyStatements: [
        { Effect: "Allow", Action: ["ses:GetSuppressedDestination"], Resource: "*" },
      ],
    });
    yield* inbound.bind("AsyncFailures", { policyStatements: [sendAsyncFailures] });
    // The reverse-token keys, one parameter, read once per container. No `kms:Decrypt` grant: the
    // value is encrypted with the AWS managed key `aws/ssm`, whose own policy lets principals of
    // this account use it through Parameter Store, and which takes no access policies of ours
    // (SSM user guide, "AWS KMS encryption for Parameter Store SecureString parameters"). A
    // customer managed key would need `kms:Decrypt` here, conditioned on
    // `kms:EncryptionContext:PARAMETER_ARN`.
    yield* inbound.bind("ReverseTokenKeys", {
      policyStatements: [
        { Effect: "Allow", Action: ["ssm:GetParameter"], Resource: reverseTokenKeysParameterArn },
        // The image proxy's keys, to sign proxy URLs (same `aws/ssm` key, no KMS grant).
        { Effect: "Allow", Action: ["ssm:GetParameter"], Resource: imageProxyKeysParameterArn },
      ],
    });
    // SES checks that it may invoke the function when the rule is created, so the rule waits for
    // this permission (it takes the function ARN from it). Only this rule may invoke it.
    const sesInvoke = yield* AWS.Lambda.Permission("SesInvokesInbound", {
      action: "lambda:InvokeFunction",
      functionName: inbound.functionArn,
      principal: "ses.amazonaws.com",
      sourceAccount: accountId,
      sourceArn: receiptRuleArn,
    });

    const ruleSet = yield* AWS.SES.ReceiptRuleSet("InboundRules", {
      ruleSetName: receiptRuleSetName,
    });
    // No recipient condition: every verified domain, shared and custom, and their subdomains.
    // SES stores the message first, then invokes the inbound Lambda with the event (no body).
    yield* AWS.SES.ReceiptRule("AllVerified", {
      ruleSetName: ruleSet.ruleSetName,
      ruleName: receiptRuleName,
      enabled: true,
      scanEnabled: true,
      tlsPolicy: "Optional",
      actions: [
        { S3Action: { BucketName: spool.bucketName, ObjectKeyPrefix: spoolPrefix } },
        { LambdaAction: { FunctionArn: sesInvoke.functionName, InvocationType: "Event" } },
      ],
    });
    yield* AWS.SES.ActiveReceiptRuleSet("Active", { ruleSetName: ruleSet.ruleSetName });

    // Bounces and complaints (PLAN.md §20.11, §20.28): every send names the configuration set,
    // whose event destination publishes BOUNCE and COMPLAINT to an SNS topic that invokes the
    // feedback Lambda. The set overrides the account's suppression settings with no reasons, so
    // SES adds nothing to the suppression list by itself: SES calls a refused message's content a
    // hard bounce too, and one crafted message must not stop a user's forwarding. The feedback
    // Lambda suppresses only addresses that are gone; complaints only get recorded.
    yield* AWS.SES.ConfigurationSet("Events", {
      configurationSetName,
      suppressedReasons: [],
    });
    const feedbackTopic = yield* AWS.SNS.Topic("SesEvents", {});
    yield* AWS.SES.ConfigurationSetEventDestination("FeedbackTopic", {
      configurationSetName,
      matchingEventTypes: ["BOUNCE", "COMPLAINT"],
      snsDestination: { topicArn: feedbackTopic.topicArn },
    });

    const feedback = yield* AWS.Lambda.Function("Feedback", {
      main: new URL("../apps/inbound/src/feedbackHandler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 256,
      timeout: Duration.seconds(30),
      logging,
      functionUrl: false,
      ...reserve(reservedConcurrency.feedback),
      // SNS invokes it asynchronously; marking a recipient twice is harmless.
      eventInvokeConfig: asyncInvokes,
      env: { ALIAS_TABLE_NAME: table.tableName, ALIAS_WEBHOOK_QUEUE_URL: webhookQueue.queueUrl },
    });
    yield* feedback.bind("AsyncFailures", { policyStatements: [sendAsyncFailures] });
    // Reads the send a bounce is about (GetItem), lists the user's recipients and counts their
    // recent hard bounces (Query, PutItem), marks recipients (UpdateItem), suppresses addresses,
    // and tells the user's webhooks (one Query for their endpoints, then SendMessage).
    yield* feedback.bind("Feedback", {
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          Resource: [tableArn],
        },
        { Effect: "Allow", Action: ["ses:PutSuppressedDestination"], Resource: "*" },
        publishWebhooks,
      ],
    });
    const snsInvoke = yield* AWS.Lambda.Permission("SnsInvokesFeedback", {
      action: "lambda:InvokeFunction",
      functionName: feedback.functionArn,
      principal: "sns.amazonaws.com",
      sourceArn: feedbackTopic.topicArn,
    });
    yield* AWS.SNS.Subscription("FeedbackSubscription", {
      topicArn: feedbackTopic.topicArn,
      protocol: "lambda",
      endpoint: snsInvoke.functionName,
    });

    // The custom-domain verification cron (PLAN.md §20.18): every ten minutes it checks the
    // domains that are due (pending ones every ten minutes, verified ones daily) over DoH and SES.
    const verifyDomains = yield* AWS.Lambda.Function("VerifyDomains", {
      main: new URL("../apps/api/src/verifyHandler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 256,
      logging,
      timeout: Duration.seconds(120),
      ...reserve(reservedConcurrency.verifyDomains),
      functionUrl: false,
      env: { ALIAS_TABLE_NAME: table.tableName, ALIAS_DOH_URL: dohUrl },
    });
    // Due domains come from the index; a check updates the domain item, and releasing an expired
    // claim is one TransactWriteItems (authorized per item through DeleteItem and UpdateItem).
    yield* verifyDomains.bind("DataAccess", {
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
          Resource: [tableArn],
        },
        { Effect: "Allow", Action: ["dynamodb:Query"], Resource: [`${tableArn}/index/gsi1`] },
      ],
    });
    yield* verifyDomains.bind("DomainIdentities", { policyStatements: domainIdentityStatements });
    // Scheduler's role may invoke only this function. A run that fails is retried by Scheduler.
    yield* AWS.Scheduler.every("10 minutes", {
      description: "Check custom domains that are due (PLAN.md §20.18)",
    }).toLambda(verifyDomains);

    // Events reach the feedback Lambda, so SES needn't also mail bounces to the sender, which
    // would be a reverse alias (the inbound pipeline drops them as `bounce` anyway).
    const sharedIdentities = yield* Effect.forEach(sharedDomains, (domain) =>
      AWS.SES.EmailIdentity(`Shared-${domain}`, {
        emailIdentity: domain,
        feedbackForwardingEnabled: false,
      }).pipe(Effect.map((identity) => ({ domain, identity }))),
    );
    // Temp-mail domains only receive (the receipt rule covers every verified domain); nothing
    // is ever sent from them, and the sending policies deny them explicitly.
    const tempIdentities = yield* Effect.forEach(tempDomains, (domain) =>
      AWS.SES.EmailIdentity(`Temp-${domain}`, {
        emailIdentity: domain,
        feedbackForwardingEnabled: false,
      }).pipe(Effect.map((identity) => ({ domain, identity }))),
    );

    // The service's DNS on Cloudflare, all DNS only (never proxied: SES, ACM and CloudFront must
    // see their own answers). Records a domain already has under the same name and type are not
    // taken over unless `--adopt` is passed (Alchemy refuses unowned records).
    if (isOnCloudflare) {
      // Easy DKIM: SES verifies a domain and signs its mail once these three CNAMEs resolve.
      yield* Effect.forEach([...sharedIdentities, ...tempIdentities], ({ domain, identity }) =>
        Effect.forEach([0, 1, 2], (index) => {
          const token = Output.map((tokens: string[]) => tokens[index] ?? "")(identity.dkimTokens);
          return Cloudflare.DNS.Record(`Dkim-${domain}-${index}`, {
            zoneId: zoneOf(domain),
            name: Output.interpolate`${token}._domainkey.${domain}`,
            type: "CNAME",
            content: Output.interpolate`${token}.dkim.amazonses.com`,
            comment: "SES Easy DKIM (PLAN.md §20.37)",
          });
        }),
      );
      // Mail for the shared domains, users' subdomains (`*.<domain>`, PLAN.md §20.8) and the
      // temp-mail domains goes to SES receiving, which the receipt rule above hands on.
      const mailNames = [
        ...sharedDomains.flatMap((domain) => [
          { id: `Mx-${domain}`, domain, name: domain },
          { id: `MxSubdomains-${domain}`, domain, name: `*.${domain}` },
        ]),
        ...tempDomains.map((domain) => ({ id: `Mx-${domain}`, domain, name: domain })),
      ];
      yield* Effect.forEach(mailNames, ({ id, domain, name }) =>
        Cloudflare.DNS.Record(id, {
          zoneId: zoneOf(domain),
          name,
          type: "MX",
          content: inboundMx,
          priority: 10,
          comment: "SES receiving (PLAN.md §20.37)",
        }),
      );
      // The app domain to the distribution; Cloudflare flattens a CNAME at a zone apex.
      yield* Cloudflare.DNS.Record("AppDomain", {
        zoneId: zoneOf(appDomain),
        name: appDomain,
        type: "CNAME",
        content: app.domainName,
        comment: "The app's CloudFront distribution (PLAN.md §20.26)",
      });
    }

    // Room for `reservedConcurrency` (PLAN.md §20.29). New accounts may start with as few as 10
    // concurrent executions; the request is submitted only while the applied quota is lower, and
    // isn't waited for (`reserve`, above). It belongs to the account, not a stage: any stage takes
    // over an open request, e.g. one a destroyed stage left behind.
    yield* AWS.ServiceQuotas.ServiceQuotaIncreaseRequest("LambdaConcurrency", {
      serviceCode: "lambda",
      quotaCode: "L-B99A9384",
      desiredValue: lambdaConcurrencyQuota,
    }).pipe(adopt(true));

    // SES reputation alarms (PLAN.md §20.13). SES reviews the account at a 5% bounce or 0.1%
    // complaint rate and may pause sending at 10% / 0.5%; these warn at half the review level and
    // again at 80% of it. Account-level metrics: every send goes through the one configuration
    // set, so per-set metrics would repeat them. CloudWatch publishes to the topic only for alarms
    // of this stack in this account (the confused-deputy policy from the CloudWatch docs).
    const alertTopicArn = `arn:aws:sns:eu-west-1:${accountId}:${alertTopicName}`;
    const alertTopic = yield* AWS.SNS.Topic("Alerts", {
      topicName: alertTopicName,
      attributes: {
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowStackAlarms",
              Effect: "Allow",
              Principal: { Service: "cloudwatch.amazonaws.com" },
              Action: "SNS:Publish",
              Resource: alertTopicArn,
              Condition: {
                ArnLike: {
                  "aws:SourceArn": `arn:aws:cloudwatch:eu-west-1:${accountId}:alarm:${alarmPrefix}*`,
                },
                StringEquals: { "aws:SourceAccount": accountId },
              },
            },
          ],
        }),
      },
    });
    if (alertEmail !== undefined) {
      yield* AWS.SNS.Subscription("AlertEmail", {
        topicArn: alertTopic.topicArn,
        protocol: "email",
        endpoint: alertEmail,
      });
    }
    // The account's monthly spend (every stage in it counts): mail when 80% is spent and when the
    // month is forecast to go over. Budgets mails directly; no SNS confirmation.
    yield* AWS.Budgets.Budget("Monthly", {
      budgetName: `alias-${stage}-monthly`,
      budgetType: "COST",
      timeUnit: "MONTHLY",
      budgetLimit: { amount: budgetUsd, unit: "USD" },
      notifications:
        alertEmail === undefined
          ? []
          : [
              { notificationType: "ACTUAL" as const, threshold: 80 },
              { notificationType: "FORECASTED" as const, threshold: 100 },
            ].map(({ notificationType, threshold }) => ({
              notificationType,
              comparisonOperator: "GREATER_THAN" as const,
              threshold,
              thresholdType: "PERCENTAGE" as const,
              subscribers: [{ subscriptionType: "EMAIL" as const, address: alertEmail }],
            })),
    });
    const reputationAlarms = [
      { name: "bounce-warning", metric: "Reputation.BounceRate", threshold: 0.025 },
      { name: "bounce-critical", metric: "Reputation.BounceRate", threshold: 0.04 },
      { name: "complaint-warning", metric: "Reputation.ComplaintRate", threshold: 0.0005 },
      { name: "complaint-critical", metric: "Reputation.ComplaintRate", threshold: 0.0008 },
    ] as const;
    yield* Effect.forEach(reputationAlarms, (alarm) =>
      AWS.CloudWatch.Alarm(`Ses-${alarm.name}`, {
        name: `${alarmPrefix}ses-${alarm.name}`,
        AlarmDescription: `SES ${alarm.metric} >= ${alarm.threshold * 100}%. Runbook: PLAN.md §20.13.`,
        Namespace: "AWS/SES",
        MetricName: alarm.metric,
        // The rate is SES's own running figure over a representative volume, not a count: the
        // highest value in an hour is the current rate, and one datapoint is enough.
        Statistic: "Maximum",
        Period: 3600,
        EvaluationPeriods: 1,
        Threshold: alarm.threshold,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        // No sends, no datapoint: keep the last state, as the SES docs recommend.
        TreatMissingData: "ignore",
        // The topic's Output, not the built ARN: the alarms wait for the topic and its policy.
        AlarmActions: [alertTopic.topicArn],
        OKActions: [alertTopic.topicArn],
      }),
    );

    // Webhook delivery (PLAN.md §20.20): SQS invokes it through an event source mapping that
    // reports partial batch failures. It reads endpoints by key, disables one that answered
    // 410 Gone, and pushes failed messages back (ChangeMessageVisibility). It needs internet
    // access, so it stays outside any VPC; the egress guard keeps it off private addresses.
    const delivery = yield* AWS.Lambda.Function("WebhookDelivery", {
      main: new URL("../apps/webhooks/src/handler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 256,
      logging,
      timeout: Duration.seconds(30),
      ...reserve(reservedConcurrency.webhookDelivery),
      functionUrl: false,
      env: {
        ALIAS_TABLE_NAME: table.tableName,
        ALIAS_WEBHOOK_QUEUE_URL: webhookQueue.queueUrl,
        ALIAS_WEBHOOK_KEYS_PARAMETER: keyrings.webhookKeys.name,
      },
    });
    // The webhook keys open endpoint secrets (read once, at cold start).
    yield* delivery.bind("Deliver", {
      policyStatements: [
        webhookKeys,
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
          Resource: [tableArn],
        },
        {
          // The first three for the event source mapping, the last for backoff.
          Effect: "Allow",
          Action: [
            "sqs:ReceiveMessage",
            "sqs:DeleteMessage",
            "sqs:GetQueueAttributes",
            "sqs:ChangeMessageVisibility",
          ],
          Resource: webhookQueueArn,
        },
      ],
    });
    yield* AWS.Lambda.EventSourceMapping("WebhookDeliveries", {
      functionName: delivery.functionName,
      eventSourceArn: webhookQueue.queueArn,
      batchSize: 10,
      functionResponseTypes: ["ReportBatchItemFailures"],
      // No more pollers than the function may run, so batches aren't throttled and returned.
      scalingConfig: { MaximumConcurrency: reservedConcurrency.webhookDelivery },
    });

    // Capacity alarms (PLAN.md §20.29), on the same topic as the SES alarms. Inbound and feedback
    // must never be throttled: their events wait, and are lost to the failures queue after six
    // hours. A throttled API or image proxy means a flood reached its cap, which is the cap
    // working, so those alarm only on a sustained count.
    const capacityAlarms = [
      {
        name: "inbound-throttled",
        what: "The inbound Lambda was throttled: SES mail is waiting.",
        Namespace: "AWS/Lambda",
        MetricName: "Throttles",
        Dimensions: [{ Name: "FunctionName", Value: inbound.functionName }],
        Statistic: "Sum" as const,
        Threshold: 1,
      },
      {
        name: "inbound-backlog",
        what: "Mail waited more than 10 minutes for the inbound Lambda.",
        Namespace: "AWS/Lambda",
        MetricName: "AsyncEventAge",
        Dimensions: [{ Name: "FunctionName", Value: inbound.functionName }],
        Statistic: "Maximum" as const,
        Threshold: 600_000,
      },
      {
        name: "feedback-throttled",
        what: "The feedback Lambda was throttled: bounces and complaints are waiting.",
        Namespace: "AWS/Lambda",
        MetricName: "Throttles",
        Dimensions: [{ Name: "FunctionName", Value: feedback.functionName }],
        Statistic: "Sum" as const,
        Threshold: 1,
      },
      {
        name: "async-failures",
        what: "Lambda gave up on an SES or SNS event; it is in the async failures queue.",
        Namespace: "AWS/SQS",
        MetricName: "ApproximateNumberOfMessagesVisible",
        Dimensions: [{ Name: "QueueName", Value: asyncFailuresQueueName }],
        Statistic: "Maximum" as const,
        Threshold: 1,
      },
      {
        name: "api-throttled",
        what: "The API reached its reserved concurrency for 5 minutes.",
        Namespace: "AWS/Lambda",
        MetricName: "Throttles",
        Dimensions: [{ Name: "FunctionName", Value: api.functionName }],
        Statistic: "Sum" as const,
        Threshold: 100,
      },
      {
        name: "image-proxy-throttled",
        what: "The image proxy reached its reserved concurrency for 5 minutes.",
        Namespace: "AWS/Lambda",
        MetricName: "Throttles",
        Dimensions: [{ Name: "FunctionName", Value: imageProxy.functionName }],
        Statistic: "Sum" as const,
        Threshold: 100,
      },
    ];
    yield* Effect.forEach(capacityAlarms, ({ name, what, ...metric }) =>
      AWS.CloudWatch.Alarm(`Capacity-${name}`, {
        ...metric,
        name: `${alarmPrefix}${name}`,
        AlarmDescription: `${what} Runbook: PLAN.md §20.29.`,
        Period: 300,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        // No invocations, no datapoint: nothing is wrong.
        TreatMissingData: "notBreaching",
        AlarmActions: [alertTopic.topicArn],
        OKActions: [alertTopic.topicArn],
      }),
    );

    return {
      apiUrl: api.functionUrl,
      tableName: table.tableName,
      spoolBucket: spool.bucketName,
      inboxBucket: inboxBucketName,
      inboundFunction: inbound.functionName,
      feedbackFunction: feedback.functionName,
      webhookDeliveryFunction: delivery.functionName,
      appUrl: appOrigin,
      distributionDomain: app.domainName,
      turnstileSiteKey: turnstile?.sitekey,
      webAclArn: firewall.webAclArn,
      verifyDomainsFunction: verifyDomains.functionName,
      asyncFailuresQueue: asyncFailures.queueUrl,
    };
  }),
);
