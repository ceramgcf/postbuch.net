import { NavLink, Outlet, useOutletContext } from 'react-router';
import { FolderOpen, Archive } from 'lucide-react';
import { GlowHeading } from '@/components/ui/GlowHeading';

const TABS = [
  { to: '/akten/elektronisch', label: 'Elektronische Akten', icon: FolderOpen },
  { to: '/akten/originale',    label: 'Originale',           icon: Archive    },
];

export default function AktenPage() {
  const outletContext = useOutletContext();
  return (
    <div className="flex flex-col h-full">
      <div className="px-5 pt-4 pb-1 shrink-0">
        <GlowHeading>Aktenverzeichnis</GlowHeading>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-border pb-2 px-5 pt-1 shrink-0">
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to}
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap
               ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`
            }
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </NavLink>
        ))}
      </div>
      <div className="flex-1 overflow-auto min-w-0">
        <Outlet context={outletContext} />
      </div>
    </div>
  );
}
