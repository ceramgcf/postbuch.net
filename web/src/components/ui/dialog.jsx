import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export function Dialog({ open, onOpenChange, children, size = 'md' }) {
  const sizeClass = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl' }[size] ?? 'max-w-md';
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[1000] isolate flex items-center justify-center">
      <div
        className="fixed inset-0 bg-foreground/20 backdrop-blur-sm"
        onClick={() => onOpenChange?.(false)}
      />
      <div role="dialog" aria-modal="true" className={`relative z-10 w-full ${sizeClass} rounded-xl bg-background p-6 shadow-2xl shadow-primary/10 border border-border/60 animate-in fade-in`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DialogTitle({ className, ...props }) {
  return <h2 className={cn('text-lg font-semibold', className)} {...props} />;
}

export function DialogDescription({ className, ...props }) {
  return <p className={cn('text-sm text-muted-foreground mt-1', className)} {...props} />;
}

export function DialogFooter({ className, ...props }) {
  return <div className={cn('flex justify-end gap-2 mt-4', className)} {...props} />;
}
