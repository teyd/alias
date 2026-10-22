import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** What `alias login` keeps: where the API is, who logged in, and the token. */
const Stored = Schema.Struct({
  apiUrl: Schema.String,
  username: Schema.String,
  token: Schema.String,
});
export type Stored = typeof Stored.Type;
const StoredJson = Schema.fromJsonString(Stored);

/** The credentials file can't be read or written, or holds something else. */
export class CredentialsUnreadable extends Schema.TaggedError<CredentialsUnreadable>()(
  "CredentialsUnreadable",
  { path: Schema.String, reason: Schema.String },
) {}

/**
 * The login, kept in a file only its owner can read (`0600`, in a `0700` directory), like the
 * AWS and GitHub CLIs do without a keychain (PLAN.md §20.23 says why not the keychain). Written
 * through a temporary file and a rename, so a crash never leaves half a token.
 */
export class Credentials extends Context.Service<
  Credentials,
  {
    readonly path: string;
    readonly load: Effect.Effect<Option.Option<Stored>, CredentialsUnreadable>;
    readonly save: (stored: Stored) => Effect.Effect<void, CredentialsUnreadable>;
    /** True when there was a login to forget. */
    readonly clear: Effect.Effect<boolean, CredentialsUnreadable>;
  }
>()("@alias/cli/Credentials") {}

/**
 * The directory: `ALIAS_CONFIG_DIR`, else `$XDG_CONFIG_HOME/alias`, else `~/.config/alias` (also
 * on macOS, as most CLIs do).
 */
const directory = Config.String("ALIAS_CONFIG_DIR").pipe(
  Config.orElse(() => Config.map(Config.String("XDG_CONFIG_HOME"), (base) => `${base}/alias`)),
  Config.orElse(() => Config.map(Config.String("HOME"), (home) => `${home}/.config/alias`)),
);

export const layer = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* directory;
    const file = path.join(dir, "credentials.json");

    const failed = Effect.mapError(
      (error: { readonly message: string }) =>
        new CredentialsUnreadable({ path: file, reason: error.message }),
    );

    const load = Effect.fn("Credentials.load")(function* () {
      if (!(yield* fs.exists(file))) return Option.none<Stored>();
      const text = yield* fs.readFileString(file);
      return Option.some(yield* Schema.decodeEffect(StoredJson)(text));
    }, failed);

    const save = Effect.fn("Credentials.save")(function* (stored: Stored) {
      yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
      const text = yield* Schema.encodeEffect(StoredJson)(stored);
      const temporary = `${file}.tmp`;
      yield* fs.writeFileString(temporary, `${text}\n`, { mode: 0o600 });
      // `mode` applies only when the file is created; make sure of it either way.
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, file);
    }, failed);

    const clear = Effect.fn("Credentials.clear")(function* () {
      if (!(yield* fs.exists(file))) return false;
      yield* fs.remove(file);
      return true;
    }, failed);

    return Credentials.of({ path: file, load: load(), save, clear: clear() });
  }),
);
