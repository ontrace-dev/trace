import { Dialog as D, DropdownMenu as DM, Popover as P, Select as SP, Switch as S, Tooltip as T } from "radix-ui";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import * as React from "react";
import { cn, initials } from "@/lib/utils";

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "primary" | "outline" | "ghost" | "danger" | "accent";
type ButtonSize = "sm" | "md" | "icon" | "icon-sm";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-fg text-[#080808] hover:bg-white border border-transparent",
  outline: "bg-white/[0.04] border border-line-strong text-fg hover:bg-white/[0.08]",
  ghost: "border border-transparent text-muted hover:text-fg hover:bg-white/[0.05]",
  danger: "border border-red-400/30 text-red-300 hover:bg-red-400/10",
  accent: "border border-accent/40 text-accent-fg accent-soft hover:border-accent/70",
};
const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-8 px-3.5 text-sm gap-1.5",
  icon: "h-[26px] w-[26px] justify-center bg-white/[0.02] border border-line text-dim hover:text-fg",
  "icon-sm": "h-6 w-6 justify-center text-dim hover:text-fg",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "outline", size = "md", loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[13px] [&_svg]:shrink-0",
        size.startsWith("icon") ? buttonSizes[size] : [buttonVariants[variant], buttonSizes[size]],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

/* ------------------------------------------------------------------ Inputs */

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full border border-line-strong bg-input px-2.5 text-base text-fg placeholder:text-dim focus:border-accent/60 focus:outline-none disabled:opacity-60",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full resize-y border border-line-strong bg-input px-2.5 py-2 text-base leading-relaxed text-fg placeholder:text-dim focus:border-accent/60 focus:outline-none",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

// Radix Select can't hold "" as an item value; map it to a sentinel so "Anyone"/"Unassigned" options work.
const EMPTY = "__empty__";

interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

/** Flatten <option> children (including mapped arrays and fragments) into items. */
function optionsFrom(children: React.ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as { value?: string | number; children?: React.ReactNode; disabled?: boolean };
    if (child.type === React.Fragment) {
      out.push(...optionsFrom(props.children));
      return;
    }
    if (child.type !== "option") return;
    const value = props.value ?? (typeof props.children === "string" ? props.children : "");
    out.push({ value: String(value), label: props.children, disabled: props.disabled });
  });
  return out;
}

/**
 * Styled select built on Radix (the primitive shadcn's Select uses). Keeps the native-like API —
 * `value`, `onChange(e => e.target.value)` and `<option>` children — so call sites stay simple.
 */
export function Select({
  value,
  onChange,
  disabled,
  className,
  children,
  placeholder,
}: {
  value?: string | number | null;
  onChange?: (e: { target: { value: string } }) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
  placeholder?: string;
}) {
  const options = optionsFrom(children);
  const current = value == null ? "" : String(value);
  return (
    <SP.Root
      value={current === "" ? EMPTY : current}
      onValueChange={(v) => onChange?.({ target: { value: v === EMPTY ? "" : v } })}
      disabled={disabled}
    >
      <SP.Trigger
        className={cn(
          "flex h-8 w-full min-w-0 items-center justify-between gap-2 border border-line-strong bg-input px-2.5 text-left text-base text-fg outline-none hover:border-white/25 focus-visible:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-dim data-[state=open]:border-accent/60",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <SP.Value placeholder={placeholder} />
        </span>
        <SP.Icon asChild>
          <ChevronDown className="size-3.5 shrink-0 text-dim" />
        </SP.Icon>
      </SP.Trigger>
      <SP.Portal>
        <SP.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[min(var(--radix-select-content-available-height),320px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden border border-line-strong bg-bar shadow-xl shadow-black/50"
        >
          <SP.Viewport className="p-1">
            {options.map((o) => (
              <SP.Item
                key={o.value || EMPTY}
                value={o.value === "" ? EMPTY : o.value}
                disabled={o.disabled}
                className="relative flex cursor-default items-center py-1.5 pr-2 pl-7 text-[12.5px] text-fg-3 outline-none select-none focus-visible:outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-fg data-[state=checked]:text-fg"
              >
                <SP.ItemIndicator className="absolute left-2 inline-flex items-center">
                  <Check className="size-3.5 text-accent-text" />
                </SP.ItemIndicator>
                <SP.ItemText>{o.label}</SP.ItemText>
              </SP.Item>
            ))}
          </SP.Viewport>
        </SP.Content>
      </SP.Portal>
    </SP.Root>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-fg-2">{label}</span>
      {children}
      {hint ? <span className="text-xs leading-relaxed text-dim">{hint}</span> : null}
    </label>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className="relative h-[18px] w-8 shrink-0 border border-line-strong bg-white/[0.06] transition-colors data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent/30 disabled:opacity-50"
    >
      <S.Thumb className="block h-3 w-3 translate-x-[2px] bg-muted transition-transform data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-accent-fg" />
    </S.Root>
  );
}

/* ------------------------------------------------------------------ Badges */

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info" | "solid-accent";
const tones: Record<Tone, string> = {
  neutral: "border-line-strong text-muted",
  accent: "border-accent/35 text-accent-fg",
  ok: "border-ok/25 text-ok",
  warn: "border-warn/35 text-warn",
  danger: "border-danger/35 text-danger",
  info: "border-info/35 text-info",
  "solid-accent": "border-transparent accent-soft text-accent-text",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  upper,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
  upper?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[17px] items-center gap-1 border px-1.5 font-mono text-[11px] leading-none font-medium whitespace-nowrap",
        upper && "tracking-[0.06em] uppercase",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11.5px] text-dim", className)}>{children}</span>;
}

export function Avatar({
  name,
  src,
  size = 28,
  tone = "accent",
  className,
}: {
  name?: string | null;
  src?: string | null;
  size?: number;
  tone?: "accent" | "neutral";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold",
        tone === "accent" ? "bg-accent/18 text-accent-fg" : "bg-white/[0.06] text-body",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.43) }}
    >
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : initials(name)}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-dim", className)} />;
}

export function SectionLabel({
  children,
  className,
  right,
}: {
  children: React.ReactNode;
  className?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="label-mono">{children}</span>
      {right}
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-16 text-center", className)}>
      {icon ? <div className="mb-1 text-dim [&_svg]:size-5">{icon}</div> : null}
      <div className="text-sm font-medium text-fg-2">{title}</div>
      {children ? <div className="max-w-sm text-xs leading-relaxed text-dim">{children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Dialog */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
        <D.Content
          className={cn(
            "fixed top-[12vh] left-1/2 z-50 flex max-h-[80vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col border border-line-strong bg-bar shadow-2xl shadow-black/60 focus:outline-none",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="flex flex-col gap-1">
              <D.Title className="text-[14px] font-semibold tracking-tight text-fg">{title}</D.Title>
              {description ? (
                <D.Description className="text-xs leading-relaxed text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">dialog</D.Description>
              )}
            </div>
            <D.Close className="text-dim hover:text-fg">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/* ------------------------------------------------------------------ Menus */

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({
  children,
  align = "end",
  className,
}: {
  children: React.ReactNode;
  align?: "start" | "end" | "center";
  className?: string;
}) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        className={cn("z-50 min-w-[180px] border border-line-strong bg-bar p-1 shadow-xl shadow-black/50", className)}
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  className,
  destructive,
}: {
  children: React.ReactNode;
  onSelect?: (e: Event) => void;
  className?: string;
  destructive?: boolean;
}) {
  return (
    <DM.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 px-2 py-1.5 text-[12.5px] text-fg-3 outline-none data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-fg [&_svg]:size-[13px] [&_svg]:text-dim",
        destructive && "text-red-300 data-[highlighted]:text-red-200",
        className,
      )}
    >
      {children}
    </DM.Item>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <DM.Label className="px-2 pt-2 pb-1 label-mono">{children}</DM.Label>;
}

export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export function PopoverContent({
  children,
  className,
  align = "start",
}: {
  children: React.ReactNode;
  className?: string;
  align?: "start" | "end" | "center";
}) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={6}
        className={cn(
          "z-50 border border-line-strong bg-bar p-2 shadow-xl shadow-black/50 focus:outline-none",
          className,
        )}
      >
        {children}
      </P.Content>
    </P.Portal>
  );
}

/* ------------------------------------------------------------------ Tooltip */

export function Tip({
  label,
  children,
  side = "bottom",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <T.Root delayDuration={250}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-50 border border-line-strong bg-bar px-2 py-1 text-[11px] text-fg-3 shadow-lg"
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export const TooltipProvider = T.Provider;

/* ------------------------------------------------------------------ Tabs (segmented) */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2.5 py-[5px] font-mono text-[11px] transition-colors",
            value === o.value ? "bg-white/[0.06] text-[#e8e8ef]" : "text-dim hover:text-fg-3",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("border border-line bg-cell", className)}>{children}</div>;
}
