import { FakeCloud } from "@alias/aws-emulators";
import { deliveryRepoSuite } from "./support/index.ts";

deliveryRepoSuite("fakecloud", FakeCloud.layer());
