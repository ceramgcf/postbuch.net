import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FolderOpen } from 'lucide-react';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { useVerbleibAblagen } from '@/hooks/useVerbleibAblagen';

/**
 * Ziel des QR-Codes auf Etiketten von Sammelmappen (`<host>/mappe/S000123`): löst die
 * Nummer auf und zeigt die Dokumente dieser Sammelmappe – genau wie ein
 * Klick in der Liste unter Akten → Originale.
 */
export default function AblageSprungPage() {
  const { ablageid = '' } = useParams();
  const nummer = ablageid.toUpperCase();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useVerbleibAblagen({ archived: 'all' });
  const ablage = (data?.data ?? []).find((a) => a.ablageid === nummer);

  useEffect(() => {
    if (!ablage) return;
    const params = new URLSearchParams({
      verbleib_ablage_id: String(ablage.id),
      verbleibBackTo: '/akten/originale',
      verbleibLabel: ablage.name,
    });
    navigate(`/postbuch?${params.toString()}`, { replace: true });
  }, [ablage, navigate]);

  if (isLoading || ablage) return <PageLoader />;
  return (
    <EmptyState
      icon={FolderOpen}
      title={`Sammelmappe ${nummer} nicht gefunden`}
      description={isError ? 'Die Sammelmappen konnten nicht geladen werden.' : 'Diese Nummer gibt es in dieser Instanz nicht (mehr).'}
    >
      <Button size="sm" variant="outline" onClick={() => navigate('/akten/originale')}>Zu den Originalen</Button>
    </EmptyState>
  );
}
