import { defineConfig } from "vite-plus";

// The same repository suite runs against fakecloud and against AWS's own DynamoDB Local.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "db:fakecloud",
          include: ["test/**/*.fakecloud.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "db:dynamodb-local",
          include: ["test/**/*.dynamodb-local.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
