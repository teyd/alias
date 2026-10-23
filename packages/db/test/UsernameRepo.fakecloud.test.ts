import { FakeCloud } from "@alias/aws-emulators";
import { usernameRepoSuite } from "./support/index.ts";

usernameRepoSuite("fakecloud", FakeCloud.layer());
