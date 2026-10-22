import { DynamoDbLocal } from "@alias/aws-emulators";
import { deviceRepoSuite } from "./support/index.ts";

deviceRepoSuite("dynamodb-local", DynamoDbLocal.layer());
