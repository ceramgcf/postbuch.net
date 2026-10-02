import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export function Spinner({ className, ...props }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-primary/60', className)} {...props} />;
}

export function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, children }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      {Icon && <Icon className="h-12 w-12 text-primary/20 mb-4" />}
      <h3 className="text-lg font-medium text-foreground/70">{title}</h3>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
