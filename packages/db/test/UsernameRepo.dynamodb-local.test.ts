import { DynamoDbLocal } from "@alias/aws-emulators";
import { usernameRepoSuite } from "./support/index.ts";

usernameRepoSuite("dynamodb-local", DynamoDbLocal.layer());
