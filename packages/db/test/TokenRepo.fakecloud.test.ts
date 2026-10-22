import { FakeCloud } from "@alias/aws-emulators";
import { tokenRepoSuite } from "./support/index.ts";

tokenRepoSuite("fakecloud", FakeCloud.layer());
