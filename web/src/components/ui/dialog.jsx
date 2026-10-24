import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useDarstellung } from '@/hooks/useDarstellung';
import { useZurueckSchliesst } from '@/hooks/useBackButtonGuard';

/**
 * Modaler Dialog. Im Mobil-Layout als Bottom-Sheet (vom unteren Rand, volle
 * Breite, scrollbar, Zurück-Taste schließt) – jede Seite bekommt das
 * automatisch, ohne eigene Mobilvariante.
 */
export function Dialog({ open, onOpenChange, children, size = 'md' }) {
  const { istMobil } = useDarstellung();
  useZurueckSchliesst(open && !!onOpenChange, () => onOpenChange?.(false));
  const sizeClass = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl' }[size] ?? 'max-w-md';
  if (!open) return null;

  if (istMobil) {
    return createPortal(
      <div className="fixed inset-0 z-[1000] isolate flex items-end justify-center">
        <div
          className="fixed inset-0 bg-foreground/25 backdrop-blur-[2px]"
          onClick={() => onOpenChange?.(false)}
        />
        <div
          role="dialog" aria-modal="true"
          className="relative z-10 flex w-full max-w-xl max-h-[92dvh] flex-col rounded-t-2xl border border-b-0 border-border/60 bg-background shadow-2xl shadow-primary/10 sheet-einblenden"
        >
          <div className="flex justify-center pt-2 pb-1" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
          <div className="overflow-y-auto overscroll-contain px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]">
            {children}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

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

// Schmal (Handy hochkant): Knöpfe untereinander und vollbreit, Hauptaktion oben.
export function DialogFooter({ className, ...props }) {
  return <div className={cn('flex flex-col-reverse gap-2 mt-4 sm:flex-row sm:justify-end max-sm:[&>*]:w-full', className)} {...props} />;
}
