/**
 * GlowHeading – page-level h1 with the same gradient + omnidirectional glow
 * as the "postbuch." brand mark on the login screen.
 *
 * Usage:
 *   <GlowHeading>Dashboard</GlowHeading>
 *   <GlowHeading className="mb-2">Abrechnungsperioden PKV & Beihilfe</GlowHeading>
 */
export function GlowHeading({ children, className = '' }) {
  return (
    <h1 className={`text-2xl font-bold ${className}`}>
      {/*
       * Outer span: relative so the absolute glow layer stays anchored to
       * exactly the same bounding box as the visible text.
       */}
      <span className="relative inline-block">
        {/*
         * Blur layer – uses the SAME gradient as the sharp layer so that the
         * Gaussian blur spreads purple pixels left-ward and teal pixels
         * right-ward, giving a colour-accurate halo.
         * (A solid-colour blur layer would tint the teal right side purple.)
         */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            background: 'linear-gradient(90deg, #7d2dbd 0%, #a56bd8 50%, #2cc5dd 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            filter: 'blur(10px)',
            opacity: 0.85,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {children}
        </span>
        {/* Sharp gradient text rendered on top */}
        <span
          style={{
            position: 'relative',
            background: 'linear-gradient(90deg, #7d2dbd 0%, #a56bd8 50%, #2cc5dd 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            whiteSpace: 'nowrap',
          }}
        >
          {children}
        </span>
      </span>
    </h1>
  );
}
