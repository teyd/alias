import { DynamoDbLocal } from "@alias/aws-emulators";
import { recipientRepoSuite } from "./support/index.ts";

recipientRepoSuite("dynamodb-local", DynamoDbLocal.layer());
