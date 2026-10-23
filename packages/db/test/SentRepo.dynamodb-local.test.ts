import { DynamoDbLocal } from "@alias/aws-emulators";
import { sentRepoSuite } from "./support/index.ts";

sentRepoSuite("dynamodb-local", DynamoDbLocal.layer());
