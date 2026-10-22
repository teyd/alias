import { FakeCloud } from "@alias/aws-emulators";
import { sentRepoSuite } from "./support/index.ts";

sentRepoSuite("fakecloud", FakeCloud.layer());
