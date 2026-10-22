import { FakeCloud } from "@alias/aws-emulators";
import { deviceRepoSuite } from "./support/index.ts";

deviceRepoSuite("fakecloud", FakeCloud.layer());
