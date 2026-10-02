import { cn } from '@/lib/utils';

export function Switch({ checked = false, disabled = false, onCheckedChange, className, label, ...props }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      {...props}
    >
      <span className={cn(
        'inline-block h-4 w-4 rounded-full bg-white transition-transform',
        checked ? 'translate-x-6' : 'translate-x-1',
      )} />
    </button>
  );
}
