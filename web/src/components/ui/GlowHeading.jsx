import { GlowText } from '@/components/layout/Marke';
import { useDarstellung } from '@/hooks/useDarstellung';
import { useSeitenTitel } from '@/hooks/useSeite';

/**
 * Seitenüberschrift im Verlauf der Wortmarke.
 *
 * Mobil übernimmt die Kopfleiste den Titel: Ein reiner Text wird dort als
 * Seitentitel gesetzt und die Überschrift selbst nicht gerendert. Enthält die
 * Überschrift Bedienelemente (z. B. umbenennen per Klick), bleibt sie stehen –
 * dann trägt `titel` den Text für die Kopfleiste.
 *
 *   <GlowHeading>Dashboard</GlowHeading>
 *   <GlowHeading titel={saldo.name}><span onClick={…}>{saldo.name}</span></GlowHeading>
 */
export function GlowHeading({ children, className = '', titel }) {
  const { istMobil } = useDarstellung();
  const istText = typeof children === 'string';
  useSeitenTitel(titel ?? (istText ? children : undefined));
  if (istMobil && istText) return null;
  return (
    <h1 className={`${istMobil ? 'text-xl' : 'text-2xl'} font-bold ${className}`}>
      <GlowText blur={10} style={{ fontSize: 'inherit', lineHeight: 'inherit', letterSpacing: 'normal' }}>{children}</GlowText>
    </h1>
  );
}
