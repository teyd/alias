import { DynamoDbLocal } from "@alias/aws-emulators";
import { accountRepoSuite } from "./support/index.ts";

accountRepoSuite("dynamodb-local", DynamoDbLocal.layer());
