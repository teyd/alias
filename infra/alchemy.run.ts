/**
 * Production infrastructure (AWS eu-west-1). Not deployed yet. Development and every test run
 * against emulators (see AGENTS.md), and `pnpm check` typechecks this file.
 *
 * The DynamoDB table comes from the same spec the emulators create (`@alias/db` Table.spec),
 * and the receipt rule matches the one `apps/inbound/bin/dev.ts` runs in the SES emulator.
 */
import { Table } from "@alias/db";
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import { localState } from "alchemy/State";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

const stage = process.env.ALIAS_STAGE ?? "local";
const sharedDomains = (process.env.ALIAS_SHARED_DOMAINS ?? "alias.test").split(",");
// Passkeys are bound to the first shared domain, which serves the web app.
const appDomain = sharedDomains[0] ?? "alias.test";
// Must be on a shared domain (checked at cold start); those are the verified SES identities.
const confirmationSender = `no-reply@${appDomain}`;
const spoolBucketName = `alias-spool-${stage}`;
const tableName = `alias-${stage}`;
/** Where SES stores received mail; `Inbound.spoolPrefix` in `@alias/aws`. */
const spoolPrefix = "inbound/";

/**
 * Reverse-alias signing keys for the inbound Lambda: `<version>:<base64url secret>` entries, the
 * first one minting (`ReverseKeys.parse` in `apps/inbound`; secrets of at least 32 bytes). A
 * deploy-time secret: the deployer (CI) passes it from its secret store, Lambda keeps environment
 * variables encrypted at rest with KMS, and the Alchemy state backend must stay private because it
 * records the value too. Rotate by putting a new key first and keeping the old one for as long as
 * replies to older mail should work. Moving it to Secrets Manager needs an emulator and a contract
 * test first (AGENTS.md).
 */
const reverseTokenKeys = process.env.ALIAS_REVERSE_TOKEN_KEYS;
if (reverseTokenKeys === undefined || reverseTokenKeys.trim() === "") {
  throw new Error("Set ALIAS_REVERSE_TOKEN_KEYS (see the comment above it) before planning.");
}

/** @public The stack Alchemy loads. */
export default Alchemy.Stack(
  "alias",
  {
    providers: AWS.providers(),
    state: stage === "local" ? localState() : AWS.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* AWS.AWSEnvironment.current;
    // Built from the fixed name so the policy is a plain string (Outputs can't be templated here).
    const tableArn = `arn:aws:dynamodb:eu-west-1:${accountId}:table/${tableName}`;
    const spoolObjects = `arn:aws:s3:::${spoolBucketName}/${spoolPrefix}*`;

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
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveSpecification: { AttributeName: Table.spec.timeToLiveAttribute, Enabled: true },
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
          Expiration: { Days: 1 },
        },
      ],
      policy: [
        {
          Effect: "Allow",
          Sid: "AllowSESPuts",
          Principal: { Service: "ses.amazonaws.com" },
          Action: ["s3:PutObject"],
          Resource: spoolObjects,
          // Only SES acting for this account, not another account's receipt rule.
          Condition: { StringEquals: { "aws:SourceAccount": accountId } },
        },
      ],
    });

    const api = yield* AWS.Lambda.Function("Api", {
      main: new URL("../apps/api/src/handler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 256,
      functionUrl: true,
      env: {
        ALIAS_TABLE_NAME: table.tableName,
        ALIAS_RP_ID: appDomain,
        ALIAS_WEB_ORIGIN: `https://${appDomain}`,
        ALIAS_SHARED_DOMAINS: sharedDomains.join(","),
        ALIAS_CONFIRMATION_FROM: confirmationSender,
      },
    });
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
          Resource: `arn:aws:ses:eu-west-1:*:identity/${appDomain}`,
        },
      ],
    });

    // What `Transport.ses` (`@alias/aws`) needs: SESv2 `SendEmail` with raw content, from the shared
    // domains only. Both actions, as Alchemy's own `SES.SendEmail` binding grants for raw sends.
    // Forwarded mail goes out from `alias+r.<token>@<user>.<shared domain>`: SES lets the shared
    // domain's identity cover its subdomains, and the wildcard covers subdomain identities should
    // one ever be created on its own. Custom domains (phase 5) add their identity ARNs.
    const sendFromSharedDomains = {
      Effect: "Allow" as const,
      Sid: "SendFromSharedDomains",
      Action: ["ses:SendEmail", "ses:SendRawEmail"],
      Resource: sharedDomains.flatMap((domain) => [
        `arn:aws:ses:eu-west-1:${accountId}:identity/${domain}`,
        `arn:aws:ses:eu-west-1:${accountId}:identity/*.${domain}`,
      ]),
    };

    // The inbound pipeline (`apps/inbound`), invoked by the receipt rule below. Raw mail is held in
    // memory (SES accepts up to 40 MB) and rewritten once, hence the memory size.
    const inbound = yield* AWS.Lambda.Function("Inbound", {
      main: new URL("../apps/inbound/src/handler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 512,
      timeout: Duration.seconds(60),
      functionUrl: false,
      // Lambda's defaults, spelled out: the pipeline's claims make retries safe (PLAN.md §20.6).
      eventInvokeConfig: { maximumRetryAttempts: 2, maximumEventAge: "6 hours" },
      env: {
        ALIAS_TABLE_NAME: table.tableName,
        ALIAS_SPOOL_BUCKET: spool.bucketName,
        ALIAS_SHARED_DOMAINS: sharedDomains.join(","),
        ALIAS_REVERSE_TOKEN_KEYS: reverseTokenKeys,
      },
    });
    // Least privilege: aliases and recipients are read by key or one partition Query, counters
    // and delivery claims are single-item writes. No index, no transactions.
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
          ],
          Resource: [tableArn],
        },
      ],
    });
    // Read and delete spooled mail, nothing else in the bucket.
    yield* inbound.bind("Spool", {
      policyStatements: [
        { Effect: "Allow", Action: ["s3:GetObject", "s3:DeleteObject"], Resource: spoolObjects },
      ],
    });
    yield* inbound.bind("SendMail", { policyStatements: [sendFromSharedDomains] });
    // SES checks that it may invoke the function when the rule is created, so the rule waits for
    // this permission (it takes the function ARN from it).
    const sesInvoke = yield* AWS.Lambda.Permission("SesInvokesInbound", {
      action: "lambda:InvokeFunction",
      functionName: inbound.functionArn,
      principal: "ses.amazonaws.com",
      sourceAccount: accountId,
    });

    const ruleSet = yield* AWS.SES.ReceiptRuleSet("Inbound", {});
    // No recipient condition: every verified domain, shared and custom, and their subdomains.
    // SES stores the message first, then invokes the inbound Lambda with the event (no body).
    yield* AWS.SES.ReceiptRule("AllVerified", {
      ruleSetName: ruleSet.ruleSetName,
      enabled: true,
      scanEnabled: true,
      tlsPolicy: "Optional",
      actions: [
        { S3Action: { BucketName: spool.bucketName, ObjectKeyPrefix: spoolPrefix } },
        { LambdaAction: { FunctionArn: sesInvoke.functionName, InvocationType: "Event" } },
      ],
    });
    yield* AWS.SES.ActiveReceiptRuleSet("Active", { ruleSetName: ruleSet.ruleSetName });

    yield* Effect.forEach(sharedDomains, (domain) =>
      AWS.SES.EmailIdentity(`Shared-${domain}`, { emailIdentity: domain }),
    );

    return {
      apiUrl: api.functionUrl,
      tableName: table.tableName,
      spoolBucket: spool.bucketName,
      inboundFunction: inbound.functionName,
    };
  }),
);
