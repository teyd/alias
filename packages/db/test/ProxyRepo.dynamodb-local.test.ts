import { DynamoDbLocal } from "@alias/aws-emulators";
import { proxyRepoSuite } from "./support/index.ts";

proxyRepoSuite("dynamodb-local", DynamoDbLocal.layer());
