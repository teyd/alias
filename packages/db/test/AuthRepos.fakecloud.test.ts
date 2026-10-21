import { FakeCloud } from "@alias/aws-emulators";
import { authRepoSuite } from "./support/index.ts";

authRepoSuite("fakecloud", FakeCloud.layer());
