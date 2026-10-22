import { FakeCloud } from "@alias/aws-emulators";
import { recipientRepoSuite } from "./support/index.ts";

recipientRepoSuite("fakecloud", FakeCloud.layer());
