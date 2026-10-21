import effect from "@mpsuesser/oxlint-plugin-effect";
import { defineConfig } from "vite-plus";

const effectRecommended = effect.configs.recommended;

/** Plain Node tooling (scripts, configs, IaC entry) is not an Effect program. */
const effectRulesOff = Object.fromEntries(
  Object.keys(effectRecommended.rules).map((rule) => [rule, "off" as const]),
);

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [".agents/**", ".claude/**", "skills-lock.json", "**/routeTree.gen.ts"],
  },
  lint: {
    ignorePatterns: [".agents/**", ".claude/**", "**/routeTree.gen.ts"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      ...effectRecommended.jsPlugins,
    ],
    rules: {
      ...effectRecommended.rules,
      "vite-plus/prefer-vite-plus-imports": "error",
      "typescript/no-explicit-any": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
    overrides: [
      {
        files: ["scripts/**/*.ts", "tools/**/bin/**/*.ts"],
        rules: { "no-console": "off" },
      },
      {
        files: [
          "scripts/**/*.ts",
          "**/vite.config.ts",
          "infra/**/*.ts",
          "tools/*/bin/install-*.ts",
        ],
        rules: effectRulesOff,
      },
      {
        // Composition roots are the only places allowed to run Effects and read the process environment.
        files: ["**/bin/**/*.ts", "apps/api/src/handler.ts", "apps/web/src/lib/api.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
          "effect/avoid-process-env": "off",
          "effect/no-service-constructor-imports": "off",
        },
      },
      {
        // Emulators wrap Node servers, child processes and files; that is their whole job.
        files: ["tools/*/src/**/*.ts", "tools/*/types/**/*.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/use-http-client-service": "off",
          "effect/use-command-executor-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/use-temp-file-scoped": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-native-fetch": "off",
        },
      },
      {
        // Tests drive the system from outside, as its clients do: real HTTP, JSON bodies, async handlers.
        files: ["**/test/**/*.ts", "e2e/**/*.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
          "effect/avoid-native-fetch": "off",
          "effect/avoid-direct-json": "off",
          "effect/effect-promise-vs-trypromise": "off",
          "effect/avoid-process-env": "off",
          "effect/avoid-untagged-errors": "off",
          "effect/no-unknown-returns": "off",
          "effect/no-service-constructor-imports": "off",
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
