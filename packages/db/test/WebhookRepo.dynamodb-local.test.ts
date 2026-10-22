import { DynamoDbLocal } from "@alias/aws-emulators";
import { webhookRepoSuite } from "./support/index.ts";

webhookRepoSuite("dynamodb-local", DynamoDbLocal.layer());
