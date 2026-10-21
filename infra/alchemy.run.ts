/**
 * Production infrastructure (AWS eu-west-1). Not deployed yet: development and every test run
 * against emulators (see AGENTS.md), and this file is typechecked by `pnpm check`.
 *
 * The DynamoDB table comes from the same spec the emulators create (`@alias/db` Table.spec),
 * and the receipt rule matches the one `tools/ses-emulator/bin/serve.ts` evaluates.
 */
import { Table } from "@alias/db";
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import { localState } from "alchemy/State";
import * as Effect from "effect/Effect";

const stage = process.env.ALIAS_STAGE ?? "local";
const sharedDomains = (process.env.ALIAS_SHARED_DOMAINS ?? "alias.test").split(",");
const spoolBucketName = `alias-spool-${stage}`;
const tableName = `alias-${stage}`;
// Built from the fixed name so the policy is a plain string (Outputs can't be templated here).
const tableArn = `arn:aws:dynamodb:eu-west-1:*:table/${tableName}`;

/** @public The stack Alchemy loads. */
export default Alchemy.Stack(
  "alias",
  {
    providers: AWS.providers(),
    state: stage === "local" ? localState() : AWS.state(),
  },
  Effect.gen(function* () {
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

    // Raw inbound mail, written by SES and deleted after processing; the lifecycle rule is the backstop.
    const spool = yield* AWS.S3.Bucket("Spool", {
      bucketName: spoolBucketName,
      lifecycleRules: [
        {
          ID: "expire-inbound",
          Status: "Enabled",
          Filter: { Prefix: "inbound/" },
          Expiration: { Days: 1 },
        },
      ],
      policy: [
        {
          Effect: "Allow",
          Sid: "AllowSESPuts",
          Principal: { Service: "ses.amazonaws.com" },
          Action: ["s3:PutObject"],
          Resource: `arn:aws:s3:::${spoolBucketName}/inbound/*`,
        },
      ],
    });

    const api = yield* AWS.Lambda.Function("Api", {
      main: new URL("../apps/api/src/handler.ts", import.meta.url).pathname,
      runtime: "nodejs24.x",
      architecture: "arm64",
      memorySize: 256,
      functionUrl: true,
      env: { ALIAS_TABLE_NAME: table.tableName },
    });
    yield* api.bind("DataAccess", {
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
          Resource: [tableArn, `${tableArn}/index/*`],
        },
      ],
    });

    const ruleSet = yield* AWS.SES.ReceiptRuleSet("Inbound", {});
    // No recipient condition: every verified domain, shared and custom, and their subdomains.
    // Roadmap phase 3 adds the Lambda action (inbound handler) after the S3 action.
    yield* AWS.SES.ReceiptRule("AllVerified", {
      ruleSetName: ruleSet.ruleSetName,
      enabled: true,
      scanEnabled: true,
      tlsPolicy: "Optional",
      actions: [{ S3Action: { BucketName: spool.bucketName, ObjectKeyPrefix: "inbound/" } }],
    });
    yield* AWS.SES.ActiveReceiptRuleSet("Active", { ruleSetName: ruleSet.ruleSetName });

    yield* Effect.forEach(sharedDomains, (domain) =>
      AWS.SES.EmailIdentity(`Shared-${domain}`, { emailIdentity: domain }),
    );

    return { apiUrl: api.functionUrl, tableName: table.tableName, spoolBucket: spool.bucketName };
  }),
);
