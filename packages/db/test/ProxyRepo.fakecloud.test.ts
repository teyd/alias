import { FakeCloud } from "@alias/aws-emulators";
import { proxyRepoSuite } from "./support/index.ts";

proxyRepoSuite("fakecloud", FakeCloud.layer());
