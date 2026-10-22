import { FakeCloud } from "@alias/aws-emulators";
import { domainRepoSuite } from "./support/index.ts";

domainRepoSuite("fakecloud", FakeCloud.layer());
