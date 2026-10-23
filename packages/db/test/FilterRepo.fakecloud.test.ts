import { FakeCloud } from "@alias/aws-emulators";
import { filterRepoSuite } from "./support/index.ts";

filterRepoSuite("fakecloud", FakeCloud.layer());
