import { FakeCloud } from "@alias/aws-emulators";
import { aliasRepoSuite } from "./support/index.ts";

aliasRepoSuite("fakecloud", FakeCloud.layer());
