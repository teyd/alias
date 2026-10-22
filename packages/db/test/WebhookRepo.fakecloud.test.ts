import { FakeCloud } from "@alias/aws-emulators";
import { webhookRepoSuite } from "./support/index.ts";

webhookRepoSuite("fakecloud", FakeCloud.layer());
