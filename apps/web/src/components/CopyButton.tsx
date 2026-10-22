import { useMutation } from "@tanstack/react-query";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies `text` to the clipboard and shows a check mark for a moment. */
export const CopyButton = ({ text, label }: { readonly text: string; readonly label: string }) => {
  const copy = useMutation({
    mutationFn: () => navigator.clipboard.writeText(text),
    onSuccess: () => setTimeout(() => copy.reset(), 1500),
  });
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} onClick={() => copy.mutate()}>
      {copy.isSuccess ? <CheckIcon className="text-success" /> : <CopyIcon />}
    </Button>
  );
};
