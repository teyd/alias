import { DynamoDbLocal } from "@alias/aws-emulators";
import { deliveryRepoSuite } from "./support/index.ts";

deliveryRepoSuite("dynamodb-local", DynamoDbLocal.layer());
