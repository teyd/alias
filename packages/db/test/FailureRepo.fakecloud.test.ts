import { FakeCloud } from "@alias/aws-emulators";
import { failureRepoSuite } from "./support/index.ts";

failureRepoSuite("fakecloud", FakeCloud.layer());
