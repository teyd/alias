import { FakeCloud } from "@alias/aws-emulators";
import { messageRepoSuite } from "./support/index.ts";

messageRepoSuite("fakecloud", FakeCloud.layer());
