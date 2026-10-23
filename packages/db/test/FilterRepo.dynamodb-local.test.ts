import { DynamoDbLocal } from "@alias/aws-emulators";
import { filterRepoSuite } from "./support/index.ts";

filterRepoSuite("dynamodb-local", DynamoDbLocal.layer());
