import { createHash, timingSafeEqual } from 'node:crypto';
import db from '../db.js';

const SDK_DEV_KEY_HASH = '76038b89807ec654ca18da6e38b1efadcddf98b3ae45226d45817a01ffebe4d3';
export const DEV_UNLOCK_SETTING = 'dev_features_unlocked';
let freigeschaltet = false;

function keyPasst(key) {
  const erwartet = Buffer.from(SDK_DEV_KEY_HASH, 'hex');
  const ist = createHash('sha256').update(String(key || ''), 'utf8').digest();
  return ist.length === erwartet.length && timingSafeEqual(ist, erwartet);
}

export async function initializeDevGate(settings = null) {
  const envOk = keyPasst(process.env.POSTBUCH_SDK_DEV_KEY || '');
  let dbOk = settings?.[DEV_UNLOCK_SETTING] === true;
  if (!settings) {
    const r = await db.query('SELECT value FROM postbuch._settings WHERE key=$1', [DEV_UNLOCK_SETTING]);
    dbOk = r.rows[0]?.value === true;
  }
  freigeschaltet = envOk || dbOk;
  return freigeschaltet;
}

export function devFeatureUnlocked() { return freigeschaltet; }

export async function unlockDevFeatures(key) {
  if (!keyPasst(key)) return false;
  await db.query(
    `INSERT INTO postbuch._settings (key,value,updated_at) VALUES ($1,'true'::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value='true'::jsonb,updated_at=now()`,
    [DEV_UNLOCK_SETTING],
  );
  freigeschaltet = true;
  return true;
}
