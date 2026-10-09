import { cn } from "@/lib/utils";

export function Mark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={cn("shrink-0", className)} aria-hidden>
      <rect width="16" height="16" fill="currentColor" />
      <rect y="7" width="16" height="2" fill="#080808" />
      <rect x="9" width="2" height="7" fill="#080808" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-3 text-fg", className)}>
      <Mark />
      <span className="font-mono text-[13px] font-semibold tracking-[0.12em]">TRACE.</span>
    </span>
  );
}
