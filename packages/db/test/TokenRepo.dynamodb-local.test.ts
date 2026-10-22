import { DynamoDbLocal } from "@alias/aws-emulators";
import { tokenRepoSuite } from "./support/index.ts";

tokenRepoSuite("dynamodb-local", DynamoDbLocal.layer());
