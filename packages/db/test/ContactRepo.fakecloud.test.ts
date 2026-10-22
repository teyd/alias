import { FakeCloud } from "@alias/aws-emulators";
import { contactRepoSuite } from "./support/index.ts";

contactRepoSuite("fakecloud", FakeCloud.layer());
