import { cn } from '@/lib/utils';

// value: 0-100 (ignoriert wenn indeterminate); indeterminate: unbestimmter Fortschritt
// (z. B. weil die Gesamtgröße noch nicht bekannt ist)
export function Progress({ value = 0, indeterminate = false, className }) {
  return (
    <div className={cn('w-full bg-muted rounded-full h-3 overflow-hidden', className)}>
      <div
        className={cn(
          'progress-gradient h-3 rounded-full',
          indeterminate ? 'w-1/3 animate-progress-indeterminate' : 'transition-[width] duration-500 ease-out'
        )}
        style={indeterminate ? undefined : { width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
