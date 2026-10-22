import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { CopyButton } from "@/components/CopyButton";
import { LoadFailed, Problem } from "@/components/states";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { aliasesQuery, createAlias, type Delivery, domainsQuery } from "@/lib/aliases";
import { inboxesQuery } from "@/lib/inboxes";

const DELIVERY: ReadonlyArray<{ readonly value: Delivery; readonly label: string }> = [
  { value: "forward", label: "Forward to my destination" },
  { value: "inbox", label: "Keep in an inbox" },
  { value: "both", label: "Forward and keep in an inbox" },
];

const CreateAliasForm = ({
  shared,
  subdomains,
  custom,
  onCreated,
}: {
  readonly shared: ReadonlyArray<string>;
  readonly subdomains: ReadonlyArray<string>;
  /** The user's verified custom domains: any address, like the subdomain. */
  readonly custom: ReadonlyArray<string>;
  readonly onCreated: () => void;
}) => {
  const addressable = Arr.appendAll(subdomains, custom);
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: createAlias,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: aliasesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: inboxesQuery.queryKey }),
      ]),
  });
  const mode: Delivery = "forward";
  const defaultValues = {
    domain: Option.getOrElse(Arr.head(Arr.appendAll(shared, subdomains)), () => ""),
    local: "",
    mode,
  };
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      const isSubdomain = Arr.contains(addressable, value.domain);
      await create.mutateAsync({
        domain: value.domain,
        local: isSubdomain ? value.local : "",
        mode: value.mode,
      });
      onCreated();
    },
  });
  const domain = useStore(form.store, (state) => state.values.domain);
  const local = useStore(form.store, (state) => Str.trim(state.values.local));
  const isSubdomain = Arr.contains(addressable, domain);
  const preview = isSubdomain && Str.isNonEmpty(local) ? `${local}@${domain}` : "";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="domain">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="alias-domain">Domain</FieldLabel>
              <Select
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value ?? "")}
              >
                <SelectTrigger id="alias-domain" className="data w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    <SelectLabel>Shared, random address</SelectLabel>
                    {Arr.map(shared, (option) => (
                      <SelectItem key={option} value={option} className="data">
                        {option}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {Arr.isReadonlyArrayNonEmpty(subdomains) && (
                    <>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Your subdomain, any address</SelectLabel>
                        {Arr.map(subdomains, (option) => (
                          <SelectItem key={option} value={option} className="data">
                            {option}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </>
                  )}
                  {Arr.isReadonlyArrayNonEmpty(custom) && (
                    <>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Your custom domains, any address</SelectLabel>
                        {Arr.map(custom, (option) => (
                          <SelectItem key={option} value={option} className="data">
                            {option}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </>
                  )}
                </SelectContent>
              </Select>
              {!isSubdomain && (
                <FieldDescription>
                  We pick a random address on a shared domain, so nobody can guess it.
                </FieldDescription>
              )}
            </Field>
          )}
        </form.Field>
        {isSubdomain && (
          <form.Field name="local">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="alias-local">Address</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="alias-local"
                    className="data"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    placeholder="shop"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText className="data">@{domain}</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            )}
          </form.Field>
        )}
        <form.Field name="mode">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="alias-mode">Delivery</FieldLabel>
              <Select
                value={field.state.value}
                items={DELIVERY}
                onValueChange={(value) => field.handleChange(value ?? "forward")}
              >
                <SelectTrigger id="alias-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {Arr.map(DELIVERY, (option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {field.state.value !== "forward" && (
                <FieldDescription>
                  Kept encrypted for a week, readable under Inbox. Codes and sign-in links are
                  picked out for you.
                </FieldDescription>
              )}
            </Field>
          )}
        </form.Field>
        {Str.isNonEmpty(preview) && (
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted px-3 py-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">Full address</span>
              <span className="data truncate">{preview}</span>
            </div>
            <CopyButton text={preview} label="Copy full address" />
          </div>
        )}
      </FieldGroup>
      <Problem error={create.error} />
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create alias"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
};

/** The "New alias" dialog; `?dialog=create` holds it open, so it can be linked. */
export const CreateAliasDialog = ({
  isOpen,
  onOpenChange,
}: {
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => {
  const domains = useQuery(domainsQuery);
  return (
    <Dialog open={isOpen} onOpenChange={(open) => onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New alias</DialogTitle>
          <DialogDescription>
            Mail to it is forwarded to your default destination, or kept in an inbox here. Replies
            go out through a reverse alias, so senders never see your mailbox.
          </DialogDescription>
        </DialogHeader>
        {domains.isPending ? (
          <Skeleton className="h-8 w-full" />
        ) : domains.isError ? (
          <LoadFailed what="your domains" onRetry={() => void domains.refetch()} />
        ) : (
          <CreateAliasForm
            shared={domains.data.shared}
            subdomains={domains.data.subdomains}
            custom={domains.data.custom}
            onCreated={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
