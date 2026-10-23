import { DynamoDbLocal } from "@alias/aws-emulators";
import { failureRepoSuite } from "./support/index.ts";

failureRepoSuite("dynamodb-local", DynamoDbLocal.layer());
