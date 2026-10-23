import type { Label, LabelColor } from "@alias/contracts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Badge } from "@/components/ui/badge";

/**
 * The dot each label colour gets (PLAN.md §20.31). Colours are names from a fixed list, so no
 * text a user typed ever reaches a class or a style; status colours stay reserved for status.
 */
const DOTS: Record<LabelColor, string> = {
  gray: "bg-zinc-400",
  red: "bg-red-400",
  orange: "bg-orange-400",
  yellow: "bg-yellow-300",
  green: "bg-emerald-400",
  teal: "bg-teal-400",
  blue: "bg-sky-400",
  violet: "bg-violet-400",
  pink: "bg-pink-400",
};

export const LabelDot = ({ color }: { readonly color: LabelColor }) => (
  <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${DOTS[color]}`} />
);

/** One label on an alias, with its colour when it has one. */
export const LabelBadge = ({
  name,
  labels,
}: {
  readonly name: string;
  /** The user's labels, for the colours. */
  readonly labels: ReadonlyArray<Label>;
}) => (
  <Badge variant="outline" className="font-normal">
    {Option.match(
      Option.flatMap(
        Arr.findFirst(labels, (label) => label.name === name),
        (label) => label.color,
      ),
      { onNone: () => null, onSome: (color) => <LabelDot color={color} /> },
    )}
    {name}
  </Badge>
);
