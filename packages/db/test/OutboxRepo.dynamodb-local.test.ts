import { DynamoDbLocal } from "@alias/aws-emulators";
import { outboxRepoSuite } from "./support/index.ts";

outboxRepoSuite("dynamodb-local", DynamoDbLocal.layer());
