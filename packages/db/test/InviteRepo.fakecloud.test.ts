import { FakeCloud } from "@alias/aws-emulators";
import { inviteRepoSuite } from "./support/index.ts";

inviteRepoSuite("fakecloud", FakeCloud.layer());
