import { useQuery } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { FingerprintIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { passkeysQuery } from "@/lib/security";

const day = (at: DateTime.Utc) => DateTime.format(at, { dateStyle: "medium" });

/** The passkeys that sign in to the account, newest use shown. */
export const Passkeys = () => {
  const passkeys = useQuery(passkeysQuery);
  if (passkeys.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (passkeys.isError) return <Problem error={passkeys.error} />;
  return Arr.match(passkeys.data, {
    onEmpty: () => <p className="text-sm text-muted-foreground">No passkeys.</p>,
    onNonEmpty: (rows) => (
      <ul className="flex flex-col gap-2">
        {rows.map((passkey) => (
          <li key={passkey.id} className="flex items-center gap-3 rounded-lg border bg-card p-3">
            <FingerprintIcon className="size-4 text-muted-foreground" aria-hidden />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">Passkey added {day(passkey.createdAt)}</span>
              <span className="text-xs text-muted-foreground">
                {Option.match(passkey.lastUsedAt, {
                  onNone: () => "Not used to sign in yet",
                  onSome: (at) => `Last used ${day(at)}`,
                })}
                {Arr.isReadonlyArrayNonEmpty(passkey.transports)
                  ? ` · ${Arr.join(passkey.transports, ", ")}`
                  : ""}
              </span>
              <span className="data truncate text-xs text-muted-foreground">{passkey.id}</span>
            </div>
          </li>
        ))}
      </ul>
    ),
  });
};
