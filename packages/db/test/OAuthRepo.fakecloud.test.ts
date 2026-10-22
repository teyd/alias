import { FakeCloud } from "@alias/aws-emulators";
import { oauthRepoSuite } from "./support/index.ts";

oauthRepoSuite("fakecloud", FakeCloud.layer());
