/**
 * Production infrastructure (AWS eu-west-1). Not deployed yet. Development and every test run
 * against emulators (see AGENTS.md), and `pnpm check` typechecks this file.
 *
 * The DynamoDB table comes from the same spec the emulators create (`@alias/db` Table.spec),
 * and the receipt rule matches the one `apps/inbound/bin/dev.ts` runs in the SES emulator.
 */
import { Table } from "@alias/db";
import { WebhookQueue } from "@alias/webhooks";
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
const alarmPrefix = `alias-${stage}-ses-`;
/**
 * Who gets the SES reputation alarms (PLAN.md §20.13). Optional: without it the topic and alarms
 * still exist (alarm state and history show in CloudWatch), but nobody is mailed. SNS sends a
 * confirmation mail first, and nothing is delivered until the link in it is followed.
 */
const alertEmail = process.env.ALIAS_ALERT_EMAIL?.trim() || undefined;

/**
 * Reverse-alias signing keys for the inbound Lambda (PLAN.md §20.14): `<version>:<base64url
 * secret>` entries, the first one minting (`ReverseKeys.parse` in `apps/inbound`; secrets of at
 * least 32 bytes). They live in an SSM Parameter Store `SecureString` (standard tier, free) that
 * the Lambda reads at cold start. This stack only names the parameter and grants reading it; it
 * never holds the value, so the value stays out of the Alchemy state and the Lambda console.
 * Before the first deploy of a stage, put it once (the default key `aws/ssm` encrypts it):
 *
 *   aws ssm put-parameter --region eu-west-1 --type SecureString \
 *     --name /alias/<stage>/reverse-token-keys \
 *     --value "1:$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
 *
 * Rotate in two puts with `--overwrite`: first append the new key (`1:<old>,2:<new>`), then, once
 * every warm container has reloaded (or after any function configuration update), put it first
 * (`2:<new>,1:<old>`). Keep the old key for as long as replies to older mail should work.
 */
const reverseTokenKeysParameter = `/alias/${stage}/reverse-token-keys`;

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
    // Sending through a configuration set is authorized on the set as well as on the identity.
    // A name with a leading slash has no extra slash in its ARN.
    const reverseTokenKeysParameterArn = `arn:aws:ssm:eu-west-1:${accountId}:parameter${reverseTokenKeysParameter}`;
    const configurationSetArn = `arn:aws:ses:eu-west-1:${accountId}:configuration-set/${configurationSetName}`;
    // The receipt rule, built from its fixed names: the bucket policy and the Lambda permission
    // both name it, and SES checks both when the rule is created, before it exists. The format is
    // the one the SES receiving docs give for these conditions.
    const receiptRuleArn = `arn:aws:ses:eu-west-1:${accountId}:receipt-rule-set/${receiptRuleSetName}:receipt-rule/${receiptRuleName}`;

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
          // Only SES acting for this account's receipt rule, not another account's or rule's.
          Condition: {
            StringEquals: { "aws:SourceAccount": accountId, "aws:SourceArn": receiptRuleArn },
          },
        },
      ],
    });

    // Logs carry no addresses or content, but still expire (PLAN.md §20.15): without a retention
    // Lambda's log groups never do.
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

    const api = yield* AWS.Lambda.Function("Api", {
      main: new URL("../apps/api/src/handler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 256,
      // Lambda's default of 3 s is too short for erasing an account with many aliases; the sweep
      // is resumable, but each retry costs the user a passkey prompt.
      timeout: Duration.seconds(30),
      logging,
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
      },
    });
    yield* api.bind("PublishWebhooks", { policyStatements: [publishWebhooks] });
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
          Resource: [`arn:aws:ses:eu-west-1:*:identity/${appDomain}`, configurationSetArn],
        },
        {
          // Re-adding a bounced address takes it off the suppression list once (§20.11).
          Effect: "Allow",
          Action: ["ses:DeleteSuppressedDestination"],
          Resource: "*",
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
      Resource: [
        ...sharedDomains.flatMap((domain) => [
          `arn:aws:ses:eu-west-1:${accountId}:identity/${domain}`,
          `arn:aws:ses:eu-west-1:${accountId}:identity/*.${domain}`,
        ]),
        configurationSetArn,
      ],
    };

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
      // Lambda's defaults, spelled out: the pipeline's claims make retries safe (PLAN.md §20.6).
      eventInvokeConfig: { maximumRetryAttempts: 2, maximumEventAge: "6 hours" },
      env: {
        ALIAS_TABLE_NAME: table.tableName,
        ALIAS_SPOOL_BUCKET: spool.bucketName,
        ALIAS_SHARED_DOMAINS: sharedDomains.join(","),
        ALIAS_REVERSE_TOKEN_KEYS_PARAMETER: reverseTokenKeysParameter,
        ALIAS_WEBHOOK_QUEUE_URL: webhookQueue.queueUrl,
        ALIAS_SES_CONFIGURATION_SET: configurationSetName,
      },
    });
    // Least privilege: aliases, recipients and contacts are read by key or one partition Query;
    // counters, quotas and delivery claims are single-item writes. A new contact and its id are
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
    yield* inbound.bind("SendMail", { policyStatements: [sendFromSharedDomains] });
    yield* inbound.bind("PublishWebhooks", { policyStatements: [publishWebhooks] });
    // The reverse-token keys, one parameter, read once per container. No `kms:Decrypt` grant: the
    // value is encrypted with the AWS managed key `aws/ssm`, whose own policy lets principals of
    // this account use it through Parameter Store, and which takes no access policies of ours
    // (SSM user guide, "AWS KMS encryption for Parameter Store SecureString parameters"). A
    // customer managed key would need `kms:Decrypt` here, conditioned on
    // `kms:EncryptionContext:PARAMETER_ARN`.
    yield* inbound.bind("ReverseTokenKeys", {
      policyStatements: [
        { Effect: "Allow", Action: ["ssm:GetParameter"], Resource: reverseTokenKeysParameterArn },
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

    const ruleSet = yield* AWS.SES.ReceiptRuleSet("Inbound", { ruleSetName: receiptRuleSetName });
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

    // Bounces and complaints (PLAN.md §20.11): every send names the configuration set, whose
    // event destination publishes BOUNCE and COMPLAINT to an SNS topic that invokes the feedback
    // Lambda. SES itself suppresses hard-bounced addresses for this set; complaints only get
    // recorded, so one "spam" click doesn't stop a user's forwarding.
    yield* AWS.SES.ConfigurationSet("Events", {
      configurationSetName,
      suppressedReasons: ["BOUNCE"],
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
      env: { ALIAS_TABLE_NAME: table.tableName, ALIAS_WEBHOOK_QUEUE_URL: webhookQueue.queueUrl },
    });
    // Marks recipients (one UpdateItem each), suppresses addresses, and tells the user's webhooks
    // (one Query for their endpoints, then SendMessage), nothing else.
    yield* feedback.bind("Feedback", {
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["dynamodb:UpdateItem", "dynamodb:Query"],
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

    // Events reach the feedback Lambda, so SES needn't also mail bounces to the sender, which
    // would be a reverse alias (the inbound pipeline drops them as `bounce` anyway).
    yield* Effect.forEach(sharedDomains, (domain) =>
      AWS.SES.EmailIdentity(`Shared-${domain}`, {
        emailIdentity: domain,
        feedbackForwardingEnabled: false,
      }),
    );

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
              Sid: "AllowReputationAlarms",
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
    const reputationAlarms = [
      { name: "bounce-warning", metric: "Reputation.BounceRate", threshold: 0.025 },
      { name: "bounce-critical", metric: "Reputation.BounceRate", threshold: 0.04 },
      { name: "complaint-warning", metric: "Reputation.ComplaintRate", threshold: 0.0005 },
      { name: "complaint-critical", metric: "Reputation.ComplaintRate", threshold: 0.0008 },
    ] as const;
    yield* Effect.forEach(reputationAlarms, (alarm) =>
      AWS.CloudWatch.Alarm(`Ses-${alarm.name}`, {
        name: `${alarmPrefix}${alarm.name}`,
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
      timeout: Duration.seconds(30),
      functionUrl: false,
      env: { ALIAS_TABLE_NAME: table.tableName, ALIAS_WEBHOOK_QUEUE_URL: webhookQueue.queueUrl },
    });
    yield* delivery.bind("Deliver", {
      policyStatements: [
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
    });

    return {
      apiUrl: api.functionUrl,
      tableName: table.tableName,
      spoolBucket: spool.bucketName,
      inboundFunction: inbound.functionName,
      feedbackFunction: feedback.functionName,
      webhookDeliveryFunction: delivery.functionName,
    };
  }),
);
