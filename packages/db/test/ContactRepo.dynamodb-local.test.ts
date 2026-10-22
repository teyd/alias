import { DynamoDbLocal } from "@alias/aws-emulators";
import { contactRepoSuite } from "./support/index.ts";

contactRepoSuite("dynamodb-local", DynamoDbLocal.layer());
