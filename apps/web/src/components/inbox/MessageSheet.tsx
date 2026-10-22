import type { MessageView } from "@alias/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { ExternalLinkIcon, ImageOffIcon, PaperclipIcon, Trash2Icon } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { LoadFailed, Problem } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { deleteMessage, messageQuery, messagesQuery } from "@/lib/inboxes";

/**
 * The page the message's HTML is shown in. The API already sanitized it; the frame is the second
 * wall: `sandbox` without `allow-scripts` or `allow-same-origin` runs nothing and reaches neither
 * the app nor its cookies, and the CSP lets it load nothing but inline images and styles. Links
 * open in a new tab (`allow-popups`), without a referrer.
 */
const framed = (html: string) =>
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
  `<meta name="referrer" content="no-referrer"><base target="_blank">` +
  `<style>body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;background:#fff;color:#111}</style>` +
  `</head><body>${html}</body></html>`;

const Body = ({ message }: { readonly message: MessageView }) =>
  Option.match(message.html, {
    onSome: (html) => (
      <iframe
        title="Message"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={framed(html)}
        className="h-[60vh] w-full rounded-lg border bg-white"
      />
    ),
    onNone: () => (
      <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted p-3 text-sm whitespace-pre-wrap">
        {Option.getOrElse(message.text, () => "")}
      </pre>
    ),
  });

/** The extracted code and link, the reason most people open a temporary inbox. */
const Found = ({ message }: { readonly message: MessageView }) =>
  Option.isNone(message.code) && Option.isNone(message.link) ? null : (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted px-3 py-2">
      {Option.match(message.code, {
        onNone: () => null,
        onSome: (code) => (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Code</span>
            <span className="data text-lg font-semibold tracking-widest">{code}</span>
            <CopyButton text={code} label="Copy code" />
          </div>
        ),
      })}
      {Option.match(message.link, {
        onNone: () => null,
        onSome: (link) => (
          <Button
            variant="outline"
            size="sm"
            render={<a href={link} target="_blank" rel="noopener noreferrer nofollow" />}
            nativeButton={false}
          >
            <ExternalLinkIcon />
            Open verification link
          </Button>
        ),
      })}
    </div>
  );

const Details = ({
  address,
  messageId,
  onClose,
}: {
  readonly address: string;
  readonly messageId: string;
  readonly onClose: () => void;
}) => {
  const message = useQuery(messageQuery(address, messageId));
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteMessage(address, messageId),
    onSuccess: () => {
      onClose();
      return queryClient.invalidateQueries({ queryKey: messagesQuery(address).queryKey });
    },
  });

  if (message.isPending) {
    return (
      <div className="flex flex-col gap-2 px-4" aria-busy>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (message.isError) {
    return (
      <div className="px-4">
        <LoadFailed what="this message" onRetry={() => void message.refetch()} />
      </div>
    );
  }
  const view = message.data;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{Option.getOrElse(view.subject, () => "(no subject)")}</SheetTitle>
        <SheetDescription>
          {Option.getOrElse(view.from, () => "Unknown sender")} ·{" "}
          <span className="data">
            {DateTime.format(view.receivedAt, { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-3 overflow-auto px-4 pb-4">
        <Found message={view} />
        {view.blockedImageCount > 0 && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <ImageOffIcon className="size-3.5" aria-hidden />
            {view.blockedImageCount} remote image{view.blockedImageCount === 1 ? "" : "s"} blocked,
            so the sender can't tell you opened it.
          </p>
        )}
        <Body message={view} />
        {Arr.isReadonlyArrayNonEmpty(view.attachments) && (
          <ul
            aria-label="Attachments"
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            {Arr.map(view.attachments, (attachment, index) => (
              <li key={index} className="flex items-center gap-2">
                <PaperclipIcon className="size-3.5" aria-hidden />
                <span className="data">
                  {Option.getOrElse(attachment.filename, () => attachment.contentType)}
                </span>
                <span>{Math.ceil(attachment.size / 1024)} KB</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Kept encrypted until{" "}
          <span className="data">{DateTime.format(view.expiresAt, { dateStyle: "medium" })}</span>,
          then deleted for good.
        </p>
        <Problem error={remove.error} />
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            <Trash2Icon />
            Delete message
          </Button>
        </div>
      </div>
    </>
  );
};

/** The message named in `?message=`, from the inbox named in `?inbox=`. */
export const MessageSheet = ({
  address,
  messageId,
  onClose,
}: {
  readonly address: Option.Option<string>;
  readonly messageId: Option.Option<string>;
  readonly onClose: () => void;
}) => {
  const open = Option.all({ address, messageId });
  return (
    <Sheet open={Option.isSome(open)} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        {Option.match(open, {
          onNone: () => null,
          onSome: (selected) => (
            <Details address={selected.address} messageId={selected.messageId} onClose={onClose} />
          ),
        })}
      </SheetContent>
    </Sheet>
  );
};
