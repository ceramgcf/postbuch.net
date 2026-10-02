import { QRCodeSVG } from 'qrcode.react';

/**
 * Constructs an EPC QR Code payload (GiroCode) following the
 * EPC016-06 / Version 002 standard (UTF-8, SEPA Credit Transfer).
 *
 * Required fields: iban, name (payee), amount (number > 0)
 * Optional:        bic, reference (Verwendungszweck, max 140 chars)
 *
 * Returns null when mandatory data is missing or invalid.
 */
function buildEpcPayload({ iban, name, amount, bic = '', reference = '' }) {
  if (!iban || !name || !amount || amount <= 0) return null;

  // Sanitise inputs: strip unsupported characters for Version 2 (UTF-8)
  const safeName = String(name).slice(0, 70).trim();
  const safeIban = String(iban).replace(/\s+/g, '').toUpperCase();
  const safeRef = String(reference || '').slice(0, 140);
  const safeBic = String(bic || '').replace(/\s+/g, '').toUpperCase();

  // Amount must be formatted as e.g. "EUR12.50" (dot decimal separator, no thousands)
  const amountStr = `EUR${parseFloat(amount).toFixed(2)}`;

  // EPC Version 002, Character set 2 (UTF-8)
  const lines = [
    'BCD',       // Service Tag
    '002',       // Version
    '2',         // Character set: UTF-8
    'SCT',       // Identification: SEPA Credit Transfer
    safeBic,     // BIC (optional – leave empty for SEPA zone)
    safeName,    // Beneficiary name
    safeIban,    // Beneficiary IBAN
    amountStr,   // Amount
    '',          // Purpose code (optional)
    '',          // Structured remittance info (optional)
    safeRef,     // Unstructured remittance info (Verwendungszweck)
    '',          // Beneficiary to originator info (optional)
  ];

  return lines.join('\n');
}

/**
 * Renders an EPC / GiroCode QR code as an inline SVG.
 *
 * Props:
 *   iban        – IBAN string
 *   name        – Payee (Zahlungsempfänger) name
 *   amount      – Amount as number (e.g. 12.50)
 *   reference   – Verwendungszweck (optional)
 *   bic         – BIC (optional)
 *   size        – QR code pixel size (default 160)
 */
export function GiroCode({ iban, name, amount, reference, bic, size = 160 }) {
  const payload = buildEpcPayload({ iban, name, amount, bic, reference });

  if (!payload) {
    return (
      <p className="text-xs text-muted-foreground italic">
        GiroCode nicht verfügbar (IBAN, Name oder Betrag fehlt)
      </p>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <QRCodeSVG
        value={payload}
        size={size}
        level="M"
        className="rounded border border-border p-1 bg-white"
      />
      <p className="text-[10px] text-muted-foreground leading-tight">
        GiroCode (EPC) – mit Banking-App scannen
      </p>
    </div>
  );
}
