import { DynamoDbLocal } from "@alias/aws-emulators";
import { aliasRepoSuite } from "./support/index.ts";

aliasRepoSuite("dynamodb-local", DynamoDbLocal.layer());
