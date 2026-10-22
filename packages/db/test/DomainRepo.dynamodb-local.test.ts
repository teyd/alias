import { DynamoDbLocal } from "@alias/aws-emulators";
import { domainRepoSuite } from "./support/index.ts";

domainRepoSuite("dynamodb-local", DynamoDbLocal.layer());
