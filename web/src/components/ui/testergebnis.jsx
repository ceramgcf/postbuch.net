import { CheckCircle2, XCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Testergebnis({ status = 'info', children, className }) {
  const cfg = {
    erfolg: [CheckCircle2, 'text-emerald-600 dark:text-emerald-400'],
    fehler: [XCircle, 'text-destructive'],
    info: [Info, 'text-muted-foreground'],
  }[status] || [Info, 'text-muted-foreground'];
  const Icon = cfg[0];
  return (
    <p role={status === 'fehler' ? 'alert' : 'status'} className={cn('mt-1.5 flex items-start gap-1.5 text-[11px]', cfg[1], className)}>
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="break-words">{children}</span>
    </p>
  );
}
