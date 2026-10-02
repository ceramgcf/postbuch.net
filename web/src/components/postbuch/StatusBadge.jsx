import { Badge } from '@/components/ui/badge';
import { STATUS_COLORS, STATUS_LABELS } from '@/lib/constants';

export function StatusBadge({ status }) {
  return (
    <Badge className={STATUS_COLORS[status] || 'text-gray-600 bg-gray-50 border-gray-200'} variant="outline">
      {STATUS_LABELS[status] || status}
    </Badge>
  );
}
