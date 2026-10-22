import { FakeCloud } from "@alias/aws-emulators";
import { accountRepoSuite } from "./support/index.ts";

accountRepoSuite("fakecloud", FakeCloud.layer());
