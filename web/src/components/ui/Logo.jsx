export function Logo({ size = 40, className = '' }) {
  return (
    <img
      src="/logo.svg"
      alt="postbuch.net"
      width={size}
      height={size}
      className={className}
      style={{ width: size, height: size }}
    />
  );
}

export function LogoWithText({ size = 40, className = '' }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <img src="/logo.svg" alt="postbuch.net" width={size} height={size} />
      <span
        className="font-bold tracking-tight"
        style={{
          fontSize: size * 0.55,
          background: 'linear-gradient(135deg, #7d2dbd 0%, #a56bd8 50%, #2cc5dd 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}
      >
        postbuch<span style={{ fontSize: '1.8em', lineHeight: 1 }}>.</span><span style={{ fontSize: '0.47em', lineHeight: 1 }}>net</span>
      </span>
    </div>
  );
}
