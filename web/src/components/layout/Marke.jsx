/**
 * Branding von postbuch.net – Logo, Wortmarke und Instanzname.
 * Einzige Quelle für Sidebar, mobile Kopfleiste und Burgermenü.
 */

const VERLAUF = 'linear-gradient(90deg, #7d2dbd 0%, #a56bd8 50%, #2cc5dd 100%)';

/**
 * Verlaufstext mit rundum gleichmäßigem Glühen.
 * Die Unschärfe-Ebene trägt denselben Verlauf wie der scharfe Text, damit
 * Violett nach links und Türkis nach rechts strahlt.
 *
 * `kuerzen`: zu lange Texte enden mit „…“. Gekürzt wird je Ebene; der
 * Weichzeichner wirkt danach und ragt deshalb ungeschnitten über den Rand.
 */
export function GlowText({ children, fontSize, blur = 6, style, kuerzen = false }) {
  const kurz = kuerzen ? { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' } : null;
  return (
    <span
      className={kuerzen ? 'relative inline-block max-w-full align-top' : 'relative inline-block'}
      style={{ fontSize, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.25, ...style }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute', top: 0, left: 0,
          background: VERLAUF,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          filter: `blur(${blur}px)`,
          opacity: 0.85,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          userSelect: 'none',
          ...(kurz && { ...kurz, right: 0 }),
        }}
      >
        {children}
      </span>
      <span
        style={{
          position: 'relative',
          background: VERLAUF,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          whiteSpace: 'nowrap',
          ...kurz,
        }}
      >
        {children}
      </span>
    </span>
  );
}

export function Wortmarke({ fontSize = 22 }) {
  return (
    <GlowText fontSize={fontSize}>
      postbuch<span style={{ fontSize: '1.8em', lineHeight: 1 }}>.</span><span style={{ fontSize: '0.47em', lineHeight: 1 }}>net</span>
    </GlowText>
  );
}

export function LogoBild({ size = 36 }) {
  const blur = Math.max(4, Math.round(size / 5));
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <img src="/logo.svg" alt="" aria-hidden width={size} height={size}
        className="absolute inset-0" style={{ filter: `blur(${blur}px)`, opacity: 0.55 }} />
      <img src="/logo.svg" alt="postbuch.net" width={size} height={size} className="relative" />
    </div>
  );
}

/** Logo + Wortmarke + Instanzname nebeneinander. */
export function MarkeVoll({ instanceName, logo = 50, schrift = 22, instanzBreite = 120 }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <LogoBild size={logo} />
      <div className="min-w-0 leading-none">
        <Wortmarke fontSize={schrift} />
        {instanceName && (
          <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5" style={{ maxWidth: instanzBreite }} title={instanceName}>
            {instanceName}
          </p>
        )}
      </div>
    </div>
  );
}
