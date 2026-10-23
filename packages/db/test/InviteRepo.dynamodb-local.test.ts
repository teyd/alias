import { DynamoDbLocal } from "@alias/aws-emulators";
import { inviteRepoSuite } from "./support/index.ts";

inviteRepoSuite("dynamodb-local", DynamoDbLocal.layer());
