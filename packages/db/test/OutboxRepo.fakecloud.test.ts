import { FakeCloud } from "@alias/aws-emulators";
import { outboxRepoSuite } from "./support/index.ts";

outboxRepoSuite("fakecloud", FakeCloud.layer());
