import { DynamoDbLocal } from "@alias/aws-emulators";
import { messageRepoSuite } from "./support/index.ts";

messageRepoSuite("dynamodb-local", DynamoDbLocal.layer());
