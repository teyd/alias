import { DynamoDbLocal } from "@alias/aws-emulators";
import { oauthRepoSuite } from "./support/index.ts";

oauthRepoSuite("dynamodb-local", DynamoDbLocal.layer());
