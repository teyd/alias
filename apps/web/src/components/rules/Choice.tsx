import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One choice from a short list, named for screen readers by `label`. */
export const Choice = <A extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  readonly label: string;
  readonly value: A;
  readonly options: ReadonlyArray<{ readonly value: A; readonly label: string }>;
  readonly onChange: (value: A) => void;
  readonly className?: string;
}) => (
  <Select
    value={value}
    items={options}
    onValueChange={(chosen) =>
      Option.match(
        Arr.findFirst(options, (option) => option.value === chosen),
        { onNone: () => undefined, onSome: (option) => onChange(option.value) },
      )
    }
  >
    <SelectTrigger aria-label={label} className={className ?? "w-full"}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent alignItemWithTrigger={false}>
      {Arr.map(options, (option) => (
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);
