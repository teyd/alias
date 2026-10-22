import type { Recipient } from "@alias/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { LockIcon } from "lucide-react";
import { Problem } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { callRecipients, recipientsQuery } from "@/lib/recipients";

/** `ABCD EF01 …`: how OpenPGP apps print fingerprints, so the owner can compare them. */
export const formatFingerprint = (fingerprint: string) =>
  (fingerprint.match(/.{1,4}/g) ?? []).join(" ");

/** The chosen `.asc` file's text, or else the pasted key. */
const keyFrom = async (form: FormData): Promise<string> => {
  const pasted = form.get("publicKey");
  const file = form.get("keyFile");
  return file instanceof File && file.size > 0 ? file.text() : P.isString(pasted) ? pasted : "";
};

/**
 * "Encryption" for one destination, held open by `?encryption=<recipient id>` (PLAN.md §20.21):
 * upload or replace its OpenPGP public key and choose whether the subject is encrypted too.
 */
export const EncryptionDialog = ({
  recipient,
  onOpenChange,
}: {
  readonly recipient: Option.Option<Recipient>;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: async (input: { readonly recipientId: string; readonly form: FormData }) => {
      const publicKey = await keyFrom(input.form);
      const isSubjectHidden = input.form.get("isSubjectHidden") === "on";
      return callRecipients((api) =>
        api.recipients.setEncryption({
          params: { recipientId: input.recipientId },
          payload: { publicKey, isSubjectHidden },
        }),
      );
    },
    onSuccess: () => {
      onOpenChange(false);
      return queryClient.invalidateQueries({ queryKey: recipientsQuery.queryKey });
    },
  });
  const current = Option.flatMap(recipient, (found) => found.encryption);

  return (
    <Dialog
      open={Option.isSome(recipient)}
      onOpenChange={(open) => onOpenChange(open)}
      onOpenChangeComplete={(open) => !open && save.reset()}
    >
      <DialogContent className="sm:max-w-lg">
        {Option.match(recipient, {
          onNone: () => null,
          onSome: (found) => (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate({ recipientId: found.id, form: new FormData(event.currentTarget) });
              }}
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <LockIcon className="size-4" aria-hidden />
                  Encrypt mail to this destination
                </DialogTitle>
                <DialogDescription>
                  Mail forwarded to <span className="data">{found.address}</span> is encrypted to
                  your OpenPGP public key (PGP/MIME), so only your mail app can read it. Mail that
                  is already encrypted is passed on as it is. Your replies aren't affected.
                </DialogDescription>
              </DialogHeader>
              {Option.match(current, {
                onNone: () => null,
                onSome: (key) => (
                  <div className="flex flex-col gap-1 rounded-lg border bg-muted p-3 text-xs">
                    <span className="text-muted-foreground">Current key</span>
                    <span className="data">{formatFingerprint(key.fingerprint)}</span>
                  </div>
                ),
              })}
              <Field data-invalid={save.isError || undefined}>
                <FieldLabel htmlFor="public-key">Public key</FieldLabel>
                <Textarea
                  id="public-key"
                  name="publicKey"
                  className="data max-h-64 min-h-32 text-xs"
                  placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
                  spellCheck={false}
                  defaultValue={Option.match(current, {
                    onNone: () => "",
                    onSome: (key) => key.publicKey,
                  })}
                  aria-invalid={save.isError}
                />
                <FieldDescription>
                  Paste the armored key (<span className="data">gpg --armor --export you@…</span>),
                  or choose its file below. Never paste a private key.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="key-file">Key file</FieldLabel>
                <Input id="key-file" name="keyFile" type="file" accept=".asc,.pub,.txt,.key" />
              </Field>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="flex flex-col gap-0.5">
                  <span id="hide-subject-label" className="font-medium">
                    Encrypt the subject too
                  </span>
                  <span id="hide-subject-description" className="text-xs text-muted-foreground">
                    The subject shows as <span className="data">[...]</span> outside, and your mail
                    app shows the real one after decrypting (Thunderbird, K-9, Mailvelope). Other
                    apps show <span className="data">[...]</span>.
                  </span>
                </div>
                <Switch
                  name="isSubjectHidden"
                  aria-labelledby="hide-subject-label"
                  aria-describedby="hide-subject-description"
                  defaultChecked={Option.exists(current, (key) => key.isSubjectHidden)}
                />
              </div>
              <Problem error={save.error} />
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <Button type="submit" disabled={save.isPending}>
                  <LockIcon />
                  {save.isPending ? "Checking…" : "Save key"}
                </Button>
              </DialogFooter>
            </form>
          ),
        })}
      </DialogContent>
    </Dialog>
  );
};
