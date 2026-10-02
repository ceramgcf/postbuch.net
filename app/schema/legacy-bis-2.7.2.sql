-- base_schema.sql — Idempotentes Vollschema für postbuch
--
-- Wird bei JEDEM Container-Start ausgeführt (via docker-entrypoint.sh).
-- Alle Statements sind idempotent: eine bestehende Produktions-DB bleibt unverändert.
--
-- Abgeleitet aus postbuch_schema.sql (pg_dump -F p Ausgabe).
-- Konvertierungen: IF NOT EXISTS überall, CREATE OR REPLACE für Funktionen/Trigger,
-- DO/EXCEPTION für ENUMs und FK-Constraints.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- ══════════════════════════════════════════════════════════════════
-- SCHEMA
-- ══════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS postbuch;

-- ══════════════════════════════════════════════════════════════════
-- EXTENSIONS
-- ══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA postbuch;

-- dblink entfernt: erlaubt aus der DB heraus ausgehende Verbindungen (SSRF auf
-- DB-Ebene) und ist ein klassisches Privilege-Escalation-Werkzeug. Im gesamten
-- Code gab es keine einzige Verwendung, und keine Funktion/View im Schema
-- postbuch greift darauf zu (geprüft über pg_proc/pg_depend).
DROP EXTENSION IF EXISTS dblink;

-- ══════════════════════════════════════════════════════════════════
-- ENUM-TYPEN (DO/EXCEPTION für Idempotenz)
-- ══════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE postbuch.abrechnungsperiode_status AS ENUM (
    'COLLECTING',
    'SUBMITTED',
    'COMPLETED',
    'OMITTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ══════════════════════════════════════════════════════════════════
-- LxD-TAXONOMIE
-- ══════════════════════════════════════════════════════════════════
-- Lebensbereich und Dokumentart sind Daten statt Enum-Werte: Betreiber dürfen
-- Darstellung und Reihenfolge pflegen, die strukturelle Spezialpipeline bleibt
-- dagegen ausschließlich mit ausgeliefertem Code verknüpft.

CREATE TABLE IF NOT EXISTS postbuch.lebensbereich (
    code text PRIMARY KEY,
    label text NOT NULL,
    erlaeuterung text NOT NULL,
    builtin boolean NOT NULL DEFAULT false,
    aktiv boolean NOT NULL DEFAULT true,
    sortierung integer NOT NULL
);

CREATE TABLE IF NOT EXISTS postbuch.dokumentart (
    code text PRIMARY KEY,
    label text NOT NULL,
    erlaeuterung text NOT NULL,
    spezial_pipeline text,
    kompatibilitaetsgruppe text NOT NULL,
    builtin boolean NOT NULL DEFAULT false,
    aktiv boolean NOT NULL DEFAULT true,
    sortierung integer NOT NULL,
    CONSTRAINT dokumentart_spezial_pipeline_ck CHECK (
      spezial_pipeline IS NULL OR spezial_pipeline IN
        ('arztrechnung', 'handwerker', 'arztbericht', 'erstattungsbescheid')
    ),
    CONSTRAINT dokumentart_builtin_pipeline_ck CHECK (builtin OR spezial_pipeline IS NULL)
);

CREATE TABLE IF NOT EXISTS postbuch.sd_aktivierung (
    lebensbereich_code text NOT NULL REFERENCES postbuch.lebensbereich(code),
    dokumentart_code text NOT NULL REFERENCES postbuch.dokumentart(code),
    builtin boolean NOT NULL DEFAULT false,
    PRIMARY KEY (lebensbereich_code, dokumentart_code)
);

-- Struktur konvergiert mit dem ausgelieferten Code; Betreiber-Tuning an Label,
-- Erläuterung, Aktivstatus und Reihenfolge bleibt nach dem ersten Seed erhalten.
INSERT INTO postbuch.lebensbereich (code, label, erlaeuterung, builtin, aktiv, sortierung)
VALUES
  ('tier', 'Tier', 'Subjekt oder Patient ist ein Haustier; dies schlägt alle anderen Lebensbereiche.', true, true, 1),
  ('steuer_behoerden', 'Steuer & Behörden', 'Steuern gegenüber dem Finanzamt sowie Personenstand, Meldewesen und Kindergeld; Steuerbescheinigungen immer hier.', true, true, 2),
  ('vorsorge', 'Vorsorge & Absicherung', 'Versicherungs- und Altersvorsorgebeziehung sowie persönliche rechtliche Vorsorge für die eigene Zukunft und Absicherung; nicht die konkrete medizinische Behandlung oder Erstattung.', true, true, 3),
  ('gesundheit', 'Gesundheit', 'Jede konkrete menschliche medizinische Behandlung, Medizin oder medizinische Versorgung einschließlich zugehöriger Hilfsmittel, Befunde und Leistungserstattungen.', true, true, 4),
  ('beruf', 'Beruf', 'Bestehendes Arbeits- oder Dienstverhältnis: Bezüge, Vertrag, Personalmaßnahme oder Arbeitgebermitteilung.', true, true, 5),
  ('bildung', 'Bildung', 'Aus- und Fortbildung: Hochschule, Schule, Seminar, Zeugnis oder Teilnahmebestätigung.', true, true, 6),
  ('mobilitaet', 'Mobilität', 'Fahrzeug wie Auto, Motorrad, Fahrrad oder Boot: Kauf, Werkstatt, Wartung, Zulassung oder Rückruf; Versicherung gehört zu Vorsorge.', true, true, 7),
  ('versorgung', 'Versorgung', 'Laufende Ver- oder Entsorgungsleistung beziehungsweise Gebühr: Strom, Gas, Wasser, Abwasser oder Abfall.', true, true, 8),
  ('wohnen', 'Wohnen', 'Immobilie, Haushalt und Haustechnik: Miete, Hausservice, Bau, Renovierung, Reparaturen am Gebäude sowie Haushaltsgroßgeräte einschließlich Anschaffung, Wartung und Reparatur.', true, true, 9),
  ('finanzen', 'Finanzen', 'Geldanlage und Konten ohne Vorsorgecharakter: Giro, Depot, Wertpapiere, Kredit oder Kreditkarte.', true, true, 10),
  ('freizeit', 'Freizeit', 'Gastronomie, Reise, Hobby, Kultur oder Sport.', true, true, 11),
  ('allgemeines', 'Allgemeines', 'Auffang, wenn kein anderer Lebensbereich greift.', true, true, 12)
ON CONFLICT (code) DO UPDATE SET builtin = EXCLUDED.builtin;

-- LxD-Begriffe präzisieren, ohne späteres Betreiber-Tuning zu überschreiben.
-- Die Bedingung trifft nur den vorigen ausgelieferten Standardtext und ist
-- dadurch sowohl auf Bestandsdaten als auch bei wiederholtem Start idempotent.
UPDATE postbuch.lebensbereich
   SET label = 'Vorsorge & Absicherung',
       erlaeuterung = 'Versicherungs- und Altersvorsorgebeziehung sowie persönliche rechtliche Vorsorge für die eigene Zukunft und Absicherung; nicht die konkrete medizinische Behandlung oder Erstattung.'
 WHERE code = 'vorsorge'
   AND label = 'Vorsorge'
   AND erlaeuterung = 'Versicherungs- und Altersvorsorgebeziehung wie Police, Beitrag oder Wertmitteilung; nicht die konkrete medizinische Erstattung.';

UPDATE postbuch.lebensbereich
   SET erlaeuterung = 'Jede konkrete menschliche medizinische Behandlung, Medizin oder medizinische Versorgung einschließlich zugehöriger Hilfsmittel, Befunde und Leistungserstattungen.'
 WHERE code = 'gesundheit'
   AND erlaeuterung = 'Konkrete menschliche Behandlung oder Medizin: Arzt, Klinik, Labor, Apotheke, Rezept, Befund oder Leistungserstattung.';

UPDATE postbuch.lebensbereich
   SET erlaeuterung = 'Immobilie, Haushalt und Haustechnik: Miete, Hausservice, Bau, Renovierung, Reparaturen am Gebäude sowie Haushaltsgroßgeräte einschließlich Anschaffung, Wartung und Reparatur.'
 WHERE code = 'wohnen'
   AND erlaeuterung = 'Immobilie und Haushaltsführung, soweit nicht spezifischer erfasst: Miete, Hausservice, Möbel oder Reparatur am Haus.';

INSERT INTO postbuch.dokumentart
  (code, label, erlaeuterung, spezial_pipeline, kompatibilitaetsgruppe, builtin, aktiv, sortierung)
VALUES
  ('arztrechnung', 'Arztrechnung', 'Rechnung einer ärztlichen oder klinischen Behandlung mit Einzelpositionen.', 'arztrechnung', 'arzt', true, true, 1),
  ('laborrechnung', 'Laborrechnung', 'Labordienstleistung; verwendet denselben Arztrechnungsblock.', 'arztrechnung', 'arzt', true, true, 2),
  ('rezept', 'Rezept', 'Ärztliche Verordnung mit PZN-Taxierung und Zweiteilung.', 'arztrechnung', 'arzt', true, true, 3),
  ('hilfsmittelrechnung', 'Hilfsmittelrechnung', 'Rechnung über medizinische Hilfsmittel.', 'arztrechnung', 'arzt', true, true, 4),
  ('erstattungsbescheid', 'Erstattungsbescheid', 'Leistungs- oder Erstattungsmitteilung von PKV oder Beihilfe.', 'erstattungsbescheid', 'erstattungsbescheid', true, true, 5),
  ('arztbericht', 'Arztbericht', 'Medizinischer Befund- oder Behandlungsbericht für Mensch oder Tier.', 'arztbericht', 'arztbericht', true, true, 6),
  ('handwerkerrechnung', 'Handwerkerrechnung', 'Rechnung einer Handwerker- oder Dienstleistung; Spezialverarbeitung nur im selbstgenutzten Wohnhaushalt.', 'handwerker', 'handwerker', true, true, 7),
  ('angebot', 'Angebot', 'Unverbindliches Angebot oder Kostenvoranschlag ohne Zahlungspflicht.', NULL, 'generisch', true, true, 8),
  ('kaufbeleg', 'Kaufbeleg', 'Nachweis eines abgeschlossenen Kaufs wie Kassenbon, Quittung oder Rückgabebeleg.', NULL, 'generisch', true, true, 9),
  ('bescheid', 'Bescheid', 'Hoheitlicher Verwaltungsakt mit Regelungscharakter oder Rechtsfolge.', NULL, 'generisch', true, true, 10),
  ('bescheinigung', 'Bescheinigung', 'Bestätigung einer Tatsache ohne Regelungscharakter.', NULL, 'generisch', true, true, 11),
  ('urkunde_ausweis', 'Urkunde/Ausweis', 'Amtliches Status- oder Identitätsdokument.', NULL, 'generisch', true, true, 12),
  ('vertrag', 'Vertrag', 'Vertragsdokument einschließlich Versicherungsschein, Police, Änderung oder Nachtrag.', NULL, 'generisch', true, true, 13),
  ('mitteilung', 'Mitteilung', 'Reine Information ohne Regelungscharakter.', NULL, 'generisch', true, true, 14),
  ('bericht_befund', 'Bericht/Befund', 'Generischer Bericht, Gutachten, Protokoll oder Messergebnis; medizinische Berichte sind Arztberichte.', NULL, 'generisch', true, true, 15),
  ('rechnung', 'Rechnung', 'Zahlungsaufforderung mit nachverfolgbarer Forderung, sofern keine spezifischere Dokumentart greift.', NULL, 'generisch', true, true, 16),
  ('korrespondenz', 'Korrespondenz', 'Schriftverkehr ohne eigene Form wie Anschreiben, Kündigung, Antrag, Mahnung oder Hinweis.', NULL, 'generisch', true, true, 17),
  ('sonstiges', 'Sonstiges', 'Auffang, wenn keine Dokumentart greift.', NULL, 'generisch', true, true, 18)
ON CONFLICT (code) DO UPDATE SET
  spezial_pipeline = EXCLUDED.spezial_pipeline,
  kompatibilitaetsgruppe = EXCLUDED.kompatibilitaetsgruppe,
  builtin = EXCLUDED.builtin;

INSERT INTO postbuch.sd_aktivierung (lebensbereich_code, dokumentart_code, builtin)
VALUES
  ('gesundheit', 'arztrechnung', true),
  ('gesundheit', 'laborrechnung', true),
  ('gesundheit', 'rezept', true),
  ('gesundheit', 'hilfsmittelrechnung', true),
  ('gesundheit', 'arztbericht', true),
  ('gesundheit', 'erstattungsbescheid', true),
  ('tier', 'arztrechnung', true),
  ('tier', 'laborrechnung', true),
  ('tier', 'rezept', true),
  ('tier', 'hilfsmittelrechnung', true),
  ('tier', 'arztbericht', true),
  ('tier', 'erstattungsbescheid', true),
  ('wohnen', 'handwerkerrechnung', true)
ON CONFLICT (lebensbereich_code, dokumentart_code) DO UPDATE SET builtin = EXCLUDED.builtin;

DO $$ BEGIN
  CREATE TYPE postbuch.post_status AS ENUM (
    'AIClearance',
    'UserClearance',
    'NeedsUserReview',
    'WaitingForAIReview'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE postbuch.post_richtung AS ENUM (
    'eingang',
    'ausgang'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE postbuch.saldo_art AS ENUM (
    'positiv',
    'negativ'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ══════════════════════════════════════════════════════════════════
-- FUNKTIONEN (CREATE OR REPLACE für Idempotenz)
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION postbuch.enforce_post_files_retention() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM postbuch.post_files
  WHERE postid IN (
    SELECT postid FROM postbuch.post_files
    ORDER BY stored_at DESC, postid DESC
    OFFSET 100
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION postbuch.fn_akte_dokument_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE postbuch.akte SET updated_at = now() WHERE akteid = OLD.akteid;
    RETURN OLD;
  ELSE
    UPDATE postbuch.akte SET updated_at = now() WHERE akteid = NEW.akteid;
    RETURN NEW;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION postbuch.fn_akte_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION postbuch.fn_revert_ap_status_on_eb_nulled() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.eb_postid IS NOT NULL AND NEW.eb_postid IS NULL AND NEW.status = 'COMPLETED' THEN
    NEW.status := 'SUBMITTED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION postbuch.fn_saldo_buchung_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE postbuch.saldo SET updated_at = now() WHERE saldo_id = OLD.saldo_id;
    RETURN OLD;
  ELSE
    UPDATE postbuch.saldo SET updated_at = now() WHERE saldo_id = NEW.saldo_id;
    RETURN NEW;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION postbuch.fn_saldo_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION postbuch.set_abrechnungsperioden_from_buch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  has_pkv boolean;
  has_beihilfe boolean;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.behandelte_person IS NOT NULL THEN
    -- Versicherungsstatus des Menschen ermitteln. Existiert er nicht, bleiben
    -- has_pkv/has_beihilfe NULL → es wird keine Periode zugeordnet.
    SELECT pkv, beihilfe INTO has_pkv, has_beihilfe
    FROM postbuch.mensch WHERE kurzname = NEW.behandelte_person;

    IF NEW.abrechnungsperiode_pkv IS NULL AND COALESCE(has_pkv, false) THEN
      SELECT MAX(periode) INTO NEW.abrechnungsperiode_pkv
      FROM postbuch.abrechnungsperiode_buch
      WHERE person = NEW.behandelte_person AND kostentraeger = 'PKV' AND status = 'COLLECTING';
    END IF;
    IF NEW.abrechnungsperiode_beihilfe IS NULL AND COALESCE(has_beihilfe, false) THEN
      SELECT MAX(periode) INTO NEW.abrechnungsperiode_beihilfe
      FROM postbuch.abrechnungsperiode_buch
      WHERE person = NEW.behandelte_person AND kostentraeger = 'Beihilfe' AND status = 'COLLECTING';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ══════════════════════════════════════════════════════════════════
-- SEQUENZEN
-- ══════════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS postbuch.akte_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE IF NOT EXISTS postbuch.app_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE IF NOT EXISTS postbuch.postbuch_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE IF NOT EXISTS postbuch.saldo_buchung_manuell_buchung_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE IF NOT EXISTS postbuch.saldo_quelle_quelle_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE IF NOT EXISTS postbuch.saldo_saldo_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE IF NOT EXISTS postbuch.ui_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE IF NOT EXISTS postbuch.wiedervorlage_wv_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- ══════════════════════════════════════════════════════════════════
-- TABELLEN (CREATE TABLE IF NOT EXISTS, PKs inline)
-- Reihenfolge: Eltern-Tabellen zuerst, Kind-Tabellen danach
-- ══════════════════════════════════════════════════════════════════

-- Hilfstabellen (keine FK-Abhängigkeiten)

CREATE TABLE IF NOT EXISTS postbuch._abrechnung_sessions (
    id uuid NOT NULL PRIMARY KEY,
    status text DEFAULT 'pending'::text NOT NULL,
    groups jsonb NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS postbuch._jobs (
    id uuid NOT NULL PRIMARY KEY,
    type text NOT NULL,
    label text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    step integer DEFAULT 0,
    total_steps integer DEFAULT 0,
    step_label text DEFAULT ''::text,
    cancellable boolean DEFAULT true,
    payload jsonb,
    started_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    error_message text
);

CREATE TABLE IF NOT EXISTS postbuch._migrations (
    name text NOT NULL PRIMARY KEY,
    applied_at timestamp with time zone DEFAULT now()
);

-- Metadaten werden unmittelbar vor jedem pg_dump geschrieben und sind damit
-- Teil desselben Backups. Der Hash beschreibt den Stand des idempotenten
-- Vollschemas der auslösenden App; einen separaten, manuell zu pflegenden
-- Schema-Versionszähler gibt es bewusst nicht.
CREATE TABLE IF NOT EXISTS postbuch._backup_metadata (
    backup_id text NOT NULL PRIMARY KEY,
    captured_at timestamp with time zone NOT NULL DEFAULT now(),
    app_version text,
    schema_sha256 text NOT NULL,
    postgres_version text NOT NULL,
    CONSTRAINT backup_metadata_app_version_check
        CHECK (app_version IS NULL OR app_version ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'),
    CONSTRAINT backup_metadata_schema_sha256_check
        CHECK (schema_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS postbuch._dr_sessions (
    id uuid NOT NULL PRIMARY KEY,
    job_id uuid,
    status text NOT NULL DEFAULT 'scanning',
    root_folder_id text NOT NULL,
    root_folder_label text,
    stats jsonb NOT NULL DEFAULT '{}'::jsonb,
    unmatched jsonb NOT NULL DEFAULT '[]'::jsonb,
    extras jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    error_message text
);

CREATE TABLE IF NOT EXISTS postbuch._settings (
    key text NOT NULL PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

-- App-Log (keine FK-Abhängigkeiten)

CREATE TABLE IF NOT EXISTS postbuch.app_log (
    id integer NOT NULL PRIMARY KEY DEFAULT nextval('postbuch.app_log_id_seq'::regclass),
    ts timestamp with time zone DEFAULT now() NOT NULL,
    level text NOT NULL,
    source text NOT NULL,
    message text NOT NULL,
    details text,
    entity text,
    entity_id text,
    CONSTRAINT app_log_level_check CHECK ((level = ANY (ARRAY['INFO'::text, 'WARN'::text, 'ERROR'::text])))
);

-- UI-Log (keine FK-Abhängigkeiten)

CREATE TABLE IF NOT EXISTS postbuch.ui_log (
    id bigint NOT NULL PRIMARY KEY DEFAULT nextval('postbuch.ui_log_id_seq'::regclass),
    ts timestamp with time zone DEFAULT now() NOT NULL,
    action text NOT NULL,
    entity text NOT NULL,
    entity_id text,
    details text
);

-- Session-Store (connect-pg-simple). Standard-DDL der Bibliothek, hier idempotent
-- und im Schema postbuch. Bewusst NICHT über createTableIfMissing angelegt, damit
-- das Schema an einer einzigen Stelle steht.
-- Zweck: Sessions überleben `docker compose up --force-recreate app` — bis hierher
-- lief express-session auf dem MemoryStore und warf bei jedem Neubau alle Logins weg.
CREATE TABLE IF NOT EXISTS postbuch.session (
    sid    varchar NOT NULL COLLATE "default" PRIMARY KEY,
    sess   json NOT NULL,
    expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON postbuch.session (expire);

-- Admin-Setting analog umbenennen, falls vorhanden.
UPDATE postbuch._settings
   SET key = 'admin_push_reminder_hour'
 WHERE key = 'admin_push_payment_reminder_hour'
   AND NOT EXISTS (SELECT 1 FROM postbuch._settings WHERE key = 'admin_push_reminder_hour');
DELETE FROM postbuch._settings WHERE key = 'admin_push_payment_reminder_hour';

-- Mensch — die einzige Identitätstabelle (fachliche Person UND App-Zugang).
--
-- Die früheren Tabellen `person` (fachlich) und `users` (Login) sind abgelöst;
-- die Migration darunter hebt Altbestände hierher und entfernt sie. Referenziert
-- wird ausschließlich per Text-Match über `kurzname` von
-- arztrechnung.behandelte_person, arztbericht.behandelte_person,
-- erstattungsbescheid_einzelposition.behandelte_person, postbuch.familienmitglied
-- und abrechnungsperiode_buch.person — bewusst ohne Fremdschlüssel.
CREATE TABLE IF NOT EXISTS postbuch.mensch (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kurzname text NOT NULL UNIQUE,
    anmeldename text UNIQUE,
    anzeigename text NOT NULL,
    email text,
    loginfaehig boolean NOT NULL DEFAULT false,
    password_hash text,
    rolle text,
    aktiv boolean NOT NULL DEFAULT true,
    pkv boolean NOT NULL DEFAULT false,
    beihilfe boolean NOT NULL DEFAULT false,
    pkv_satz numeric(5,2),
    beihilfe_satz numeric(5,2),
    archiviert boolean NOT NULL DEFAULT false,
    farbe text,
    webpush_subscriptions jsonb NOT NULL DEFAULT '[]'::jsonb,
    notification_push boolean NOT NULL DEFAULT true,
    notification_discord boolean NOT NULL DEFAULT true,
    push_new_doc boolean NOT NULL DEFAULT true,
    push_reprocess boolean NOT NULL DEFAULT true,
    push_error boolean NOT NULL DEFAULT true,
    push_duplicate boolean NOT NULL DEFAULT true,
    push_wiedervorlage boolean NOT NULL DEFAULT true,
    push_payment boolean NOT NULL DEFAULT true,
    push_payment_offset_days integer NOT NULL DEFAULT 3,
    push_reminder_hour integer NOT NULL DEFAULT 9,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mensch_rolle_ck CHECK (rolle IS NULL OR rolle IN ('vollzugriff', 'lesezugriff')),
    CONSTRAINT mensch_login_ck CHECK (
      NOT loginfaehig OR (anmeldename IS NOT NULL AND password_hash IS NOT NULL AND rolle IS NOT NULL)
    ),
    CONSTRAINT mensch_credentials_ck CHECK (
      (anmeldename IS NULL AND password_hash IS NULL AND rolle IS NULL)
      OR (anmeldename IS NOT NULL AND password_hash IS NOT NULL AND rolle IS NOT NULL)
    ),
    CONSTRAINT mensch_push_offset_ck CHECK (push_payment_offset_days BETWEEN 0 AND 60),
    CONSTRAINT mensch_push_hour_ck CHECK (push_reminder_hour BETWEEN 0 AND 23)
);

CREATE INDEX IF NOT EXISTS mensch_aktiv_idx ON postbuch.mensch (aktiv, archiviert);
CREATE INDEX IF NOT EXISTS mensch_login_idx ON postbuch.mensch (anmeldename) WHERE loginfaehig;

-- Ein Tier bleibt im etablierten Menschenmodell, damit keine zweite große
-- Identitätsmigration an LxD gekoppelt wird.
ALTER TABLE postbuch.mensch ADD COLUMN IF NOT EXISTS ist_tier boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensch_pkv_satz_ck') THEN
    ALTER TABLE postbuch.mensch ADD CONSTRAINT mensch_pkv_satz_ck
      CHECK (pkv_satz IS NULL OR pkv_satz BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensch_beihilfe_satz_ck') THEN
    ALTER TABLE postbuch.mensch ADD CONSTRAINT mensch_beihilfe_satz_ck
      CHECK (beihilfe_satz IS NULL OR beihilfe_satz BETWEEN 0 AND 100);
  END IF;
  -- Tiere können eine Tierkrankenversicherung (PKV) haben, aber keine Beihilfe.
  -- Das verhindert auch nach manuellen API-Aufrufen eine Vermischung der
  -- Abrechnungsperioden beider Patientengruppen.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mensch_tier_keine_beihilfe_ck') THEN
    ALTER TABLE postbuch.mensch ADD CONSTRAINT mensch_tier_keine_beihilfe_ck
      CHECK (NOT ist_tier OR NOT beihilfe);
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- MIGRATION Legacy-Identitäten → mensch (selbstauflösend)
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Früher trugen `person` (fachlich) und `users` (Login) die Identitäten, gehalten
-- von gegenseitigen Sync-Triggern. Beides ist abgelöst. Dieser Block hebt einen
-- eventuell noch vorhandenen Altbestand einmalig nach `mensch` und löscht die
-- Legacy-Tabellen anschließend; ab dem zweiten Lauf sind alle Schritte No-ops.
--
-- Das dynamische SQL ist Pflicht, nicht Stilfrage: statisch geparste Verweise auf
-- die dann fehlenden Tabellen würden jeden weiteren App-Start brechen.
DO $$
DECLARE
  unscharf integer := 0;
BEGIN
  IF to_regclass('postbuch.person') IS NOT NULL THEN
    -- 1) Fachliche Personen übernehmen. Ein bereits vorhandener Mensch mit
    --    gleichem Kurznamen bleibt unangetastet (seine UUID zählt).
    EXECUTE $sql$
      INSERT INTO postbuch.mensch
        (kurzname, anzeigename, pkv, beihilfe, pkv_satz, beihilfe_satz,
         archiviert, farbe, created_at, updated_at)
      SELECT p.kurzname, p.vollname, p.pkv, p.beihilfe, p.pkv_satz,
             p.beihilfe_satz, p.archiviert, p.farbe, p.created_at, p.updated_at
        FROM postbuch.person p
      ON CONFLICT (kurzname) DO NOTHING
    $sql$;
  END IF;

  IF to_regclass('postbuch.users') IS NOT NULL THEN
    -- 2) Sehr alte Bestände kennen die Push-Spalten noch nicht — idempotent
    --    nachziehen, damit die Übernahme unten sie lesen darf.
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'postbuch' AND table_name = 'users'
                  AND column_name = 'push_payment_reminder_hour')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'postbuch' AND table_name = 'users'
                          AND column_name = 'push_reminder_hour') THEN
      EXECUTE 'ALTER TABLE postbuch.users RENAME COLUMN push_payment_reminder_hour TO push_reminder_hour';
    END IF;
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS webpush_subscriptions jsonb';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS notification_push boolean';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS notification_discord boolean';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS push_new_doc boolean';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS push_reprocess boolean';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS push_error boolean';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS push_duplicate boolean';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS push_wiedervorlage boolean';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS push_payment boolean';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS push_payment_offset_days integer';
    EXECUTE 'ALTER TABLE postbuch.users ADD COLUMN IF NOT EXISTS push_reminder_hour integer';

    -- 3) Namen, die sich nur in der Schreibweise unterscheiden, werden bewusst
    --    NICHT automatisch zusammengeführt — sie wandern als getrennte Menschen
    --    mit und werden hier einmal sichtbar gemacht.
    IF to_regclass('postbuch.person') IS NOT NULL THEN
      EXECUTE $sql$
        SELECT count(*)::int FROM postbuch.users u
          JOIN postbuch.person p ON lower(p.kurzname) = lower(u.username)
                                AND p.kurzname <> u.username
      $sql$ INTO unscharf;
      IF unscharf > 0 THEN
        RAISE WARNING 'Mensch-Migration: % Login-Name(n) weichen nur in der Schreibweise vom Personen-Kurznamen ab und wurden als eigenstaendige Menschen uebernommen — bitte im UI zusammenfuehren.', unscharf;
      END IF;
    END IF;

    -- 4) Zugangsdaten auf den gleichnamigen Menschen heben.
    EXECUTE $sql$
      UPDATE postbuch.mensch m SET
        anmeldename = u.username, password_hash = u.password_hash, rolle = u.role,
        loginfaehig = true, aktiv = true,
        webpush_subscriptions = COALESCE(u.webpush_subscriptions, m.webpush_subscriptions),
        notification_push = COALESCE(u.notification_push, m.notification_push),
        notification_discord = COALESCE(u.notification_discord, m.notification_discord),
        push_new_doc = COALESCE(u.push_new_doc, m.push_new_doc),
        push_reprocess = COALESCE(u.push_reprocess, m.push_reprocess),
        push_error = COALESCE(u.push_error, m.push_error),
        push_duplicate = COALESCE(u.push_duplicate, m.push_duplicate),
        push_wiedervorlage = COALESCE(u.push_wiedervorlage, m.push_wiedervorlage),
        push_payment = COALESCE(u.push_payment, m.push_payment),
        push_payment_offset_days = COALESCE(u.push_payment_offset_days, m.push_payment_offset_days),
        push_reminder_hour = COALESCE(u.push_reminder_hour, m.push_reminder_hour),
        updated_at = now()
      FROM postbuch.users u
      WHERE m.kurzname = u.username AND m.anmeldename IS NULL
    $sql$;

    -- 5) Reine Login-Nutzer ohne fachliche Person werden eigenständige Menschen.
    EXECUTE $sql$
      INSERT INTO postbuch.mensch
        (kurzname, anmeldename, anzeigename, loginfaehig, password_hash, rolle,
         webpush_subscriptions, notification_push, notification_discord,
         push_new_doc, push_reprocess, push_error, push_duplicate,
         push_wiedervorlage, push_payment, push_payment_offset_days,
         push_reminder_hour, created_at, updated_at)
      SELECT u.username, u.username, u.username, true, u.password_hash, u.role,
             COALESCE(u.webpush_subscriptions, '[]'::jsonb),
             COALESCE(u.notification_push, true), COALESCE(u.notification_discord, true),
             COALESCE(u.push_new_doc, true), COALESCE(u.push_reprocess, true),
             COALESCE(u.push_error, true), COALESCE(u.push_duplicate, true),
             COALESCE(u.push_wiedervorlage, true), COALESCE(u.push_payment, true),
             COALESCE(u.push_payment_offset_days, 3), COALESCE(u.push_reminder_hour, 9),
             u.created_at, now()
        FROM postbuch.users u
       WHERE NOT EXISTS (SELECT 1 FROM postbuch.mensch m
                          WHERE m.anmeldename = u.username OR m.kurzname = u.username)
      ON CONFLICT (kurzname) DO NOTHING
    $sql$;
  END IF;
END $$;

-- Legacy-Tabellen entfernen. Ihre Sync-Trigger fallen mit der Tabelle; die
-- Trigger-Funktionen und das Migrationsgerüst müssen einzeln weg.
DROP TABLE IF EXISTS postbuch.person;
DROP TABLE IF EXISTS postbuch.users;
DROP TABLE IF EXISTS postbuch._mensch_migrationskonflikt;
DROP FUNCTION IF EXISTS postbuch.fn_legacy_user_to_mensch();
DROP FUNCTION IF EXISTS postbuch.fn_legacy_person_to_mensch();
DROP FUNCTION IF EXISTS postbuch.fn_person_updated_at();
DROP FUNCTION IF EXISTS postbuch.fn_privatpatient_updated_at();
ALTER TABLE postbuch.mensch DROP COLUMN IF EXISTS legacy_person_kurzname;
ALTER TABLE postbuch.mensch DROP COLUMN IF EXISTS legacy_username;

-- Ganz alte Bestände ohne jede Identitätstabelle: Menschen aus den vorhandenen
-- Abrechnungsperioden ableiten.
DO $$
DECLARE
  rec RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM postbuch.mensch LIMIT 1)
     AND to_regclass('postbuch.abrechnungsperiode_buch') IS NOT NULL THEN
    FOR rec IN
      SELECT person,
             bool_or(kostentraeger = 'PKV')      AS has_pkv,
             bool_or(kostentraeger = 'Beihilfe') AS has_beihilfe
      FROM postbuch.abrechnungsperiode_buch
      GROUP BY person
    LOOP
      INSERT INTO postbuch.mensch (kurzname, anzeigename, pkv, beihilfe, archiviert)
      VALUES (rec.person, rec.person, COALESCE(rec.has_pkv, false), COALESCE(rec.has_beihilfe, false), false)
      ON CONFLICT (kurzname) DO NOTHING;
    END LOOP;
  END IF;
END $$;


-- Saldo (keine FK-Abhängigkeiten)

CREATE TABLE IF NOT EXISTS postbuch.saldo (
    saldo_id integer NOT NULL PRIMARY KEY DEFAULT nextval('postbuch.saldo_saldo_id_seq'::regclass),
    name text NOT NULL,
    beschreibung text,
    invisible boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Akte (keine FK-Abhängigkeiten)

CREATE TABLE IF NOT EXISTS postbuch.akte (
    akteid character varying(7) DEFAULT ('A'::text || lpad((nextval('postbuch.akte_seq'::regclass))::text, 6, '0'::text)) NOT NULL PRIMARY KEY,
    betreff text NOT NULL,
    beschreibung text,
    schlagwoerter text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notiz text,
    embedding postbuch.halfvec(3072),
    CONSTRAINT akteid_format_ck CHECK (((akteid)::text ~ '^A[0-9]{6}$'::text))
);

-- Originalverbleib-Kategorien (admin-konfigurierbar, kein FK auf postbuch)

CREATE TABLE IF NOT EXISTS postbuch.verbleib_kategorie (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT 'HelpCircle',
    sort_order INT  NOT NULL DEFAULT 0,
    archived   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: Basis-Kategorien (idempotent)
INSERT INTO postbuch.verbleib_kategorie (id, name, icon, sort_order)
VALUES
  (1, 'Unbekannt',       'FileQuestionMark', 0),
  (2, 'Vernichtet',      'Shredder',         1),
  (3, 'Sammelordner',    'FolderClock',      2),
  (4, 'Themenordner',    'BookType',         3),
  (5, 'Fremdverwahrung', 'FolderOutput',     4),
  (6, 'Rein digital',    'Monitor',          5)
ON CONFLICT (id) DO NOTHING;
-- Sequence nach Seed auf mind. 6 heben (idempotent)
SELECT setval('postbuch.verbleib_kategorie_id_seq',
  GREATEST((SELECT last_value FROM postbuch.verbleib_kategorie_id_seq), 6), true);

-- Physische Ablageorte (Instanzen der Verbleib-Kategorien, FK auf verbleib_kategorie)

CREATE TABLE IF NOT EXISTS postbuch.verbleib_ablage (
    id           SERIAL PRIMARY KEY,
    kategorie_id INT NOT NULL REFERENCES postbuch.verbleib_kategorie(id),
    name         TEXT NOT NULL,
    archived     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keine doppelten aktiven Ablagen pro Kategorie
CREATE UNIQUE INDEX IF NOT EXISTS verbleib_ablage_name_aktiv_unique
    ON postbuch.verbleib_ablage(kategorie_id, name)
    WHERE archived = false;

-- Haupttabelle postbuch (keine FK-Abhängigkeiten)

CREATE TABLE IF NOT EXISTS postbuch.postbuch (
    postid character varying(7) DEFAULT ('P'::text || lpad((nextval('postbuch.postbuch_seq'::regclass))::text, 6, '0'::text)) NOT NULL PRIMARY KEY,
    briefdatum date,
    erfassungsdatum date DEFAULT CURRENT_DATE,
    kontakt text,
    fremdes_zeichen text,
    art text NOT NULL,
    betreff text,
    onedrive_id text,
    link text,
    status postbuch.post_status DEFAULT 'AIClearance'::postbuch.post_status,
    autoreview_instructions text,
    confidence numeric(3,2) DEFAULT 0.00,
    metadata jsonb,
    zusammenfassung text,
    schlagwoerter text[],
    notiz text,
    historisch boolean DEFAULT false NOT NULL,
    familienmitglied text,
    richtung postbuch.post_richtung NOT NULL DEFAULT 'eingang',
    embedding postbuch.halfvec(3072),
    sha256 text,
    onedrive_filename text,
    onedrive_modified timestamp with time zone,
    ai_model text,
    ai_pre_model text,
    ai_tokens_in integer,
    ai_tokens_out integer,
    ai_pre_tokens_in integer,
    ai_pre_tokens_out integer,
    ai_cost_usd numeric(10,6),
    ai_pre_cost_usd numeric(10,6),
    CONSTRAINT confidence_ck CHECK (((confidence >= 0.00) AND (confidence <= 1.00))),
    CONSTRAINT link_url_ck CHECK (((link IS NULL) OR (link ~ '^https?://'::text))),
    CONSTRAINT postid_format_ck CHECK (((postid)::text ~ '^P[0-9]{6}$'::text)),
    CONSTRAINT sha256_format_ck CHECK ((sha256 IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$'))
);

-- Spalten-Migrationen postbuch (idempotent, für Upgrades bestehender Installationen)
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS onedrive_filename text;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS onedrive_modified timestamp with time zone;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS ai_model text;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS ai_pre_model text;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS ai_tokens_in integer;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS ai_tokens_out integer;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS ai_pre_tokens_in integer;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS ai_pre_tokens_out integer;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS ai_cost_usd numeric(10,6);
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS ai_pre_cost_usd numeric(10,6);

-- LxD-Gerüst: während Phase A bleibt die alte Pipeline aktiv. Die neuen Achsen
-- sind deshalb nullable und noch nicht per FK an den neuen Code gebunden.
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS lebensbereich text;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS dokumentart text;
-- Nachprüf-Markierung der Migration wurde nicht gebraucht und wieder verworfen.
ALTER TABLE postbuch.postbuch DROP COLUMN IF EXISTS lxd_nachpruefung;

-- Persistenter Audit-Trail des einmaligen LxD-Bestandslaufs. Statuswerte
-- tragen bewusst keinen CHECK: neue Resume-Zustände dürfen das Vollschema nicht
-- mit einem destruktiven Constraint-Umbau gefährden.
CREATE TABLE IF NOT EXISTS postbuch._lxd_migration_items (
    postid character varying(7) PRIMARY KEY REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'offen',
    neues_l text,
    neues_d text,
    konfidenz text,
    kosten_tier text,
    begruendung text,
    fehler_text text,
    entschieden_at timestamptz,
    fertig_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lxd_migration_items_status_idx
  ON postbuch._lxd_migration_items(status);

-- Rollback-Snapshot des einmaligen LxD-Bestandslaufs: Rückbau bestätigt auf
-- allen 3 Instanzen (Master + 2 Fremdinstanzen), kein Sicherheitsnetz mehr nötig.
DROP TABLE IF EXISTS postbuch._lxd_migration_snapshot;

-- Upgrade-Bridge für 2.5.x-Fremdinstanzen: dort ist `art` noch post_art.
-- Frische und bereits migrierte Instanzen besitzen den Typ nicht; der
-- Katalogcheck vermeidet deshalb absichtlich einen direkten ::regtype-Cast.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE a.attrelid = 'postbuch.postbuch'::regclass
       AND a.attname = 'art'
       AND NOT a.attisdropped
       AND n.nspname = 'postbuch'
       AND t.typname = 'post_art'
  ) THEN
    ALTER TABLE postbuch.postbuch ALTER COLUMN art TYPE text USING art::text;
  END IF;
END $$;

-- Crash-sicheres Wiederaufnehmen muss auch den Nachprüfmarker erhalten.
ALTER TABLE postbuch._lxd_migration_items
  ADD COLUMN IF NOT EXISTS nachpruefung boolean NOT NULL DEFAULT false;

-- Embedding-Fehler-Tracking (Soft-Fail: Dokument landet in DB, aber ohne Embedding)
-- Wird gesetzt wenn fetchEmbeddingForExtractedData() in der Pipeline wirft.
-- Wird gelöscht wenn storeEmbedding() erfolgreich ein Embedding speichert.
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS embedding_failed_at timestamptz;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS embedding_error text;

-- Nachweis der Phase-2.5-Prüfung (service/extract-validator.js): WANN und WAS an
-- der KI-Ausgabe korrigiert werden musste. Bewusst getrennt von metadata (dem
-- unveränderten Modell-Ergebnis) und von qualityFlags.warnungen (der vom Modell
-- selbst geäußerten Unsicherheit) — sonst verwischt die Herkunft zwischen „das
-- hat die KI gesagt" und „das hat der Code nachträglich repariert".
-- Form von data_repairs:
--   [{ "feld": "dokumentTyp", "regel": "ENUM", "roh": "\"erstattungsbescheid\"",
--      "ergebnis": "ki-korrigiert", "neu": "\"Erstattungsbescheid\"" }, …]
-- ergebnis ∈ ki-korrigiert | koerziert | genullt | unreparierbar
-- Kosten des Repair-Calls stehen in llm_call_log (kategorie = 'repair'), damit es
-- keine zweite Kostenquelle zu pflegen gibt.
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS data_repaired_at timestamptz;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS data_repairs jsonb;

-- Embedding-Signatur "<providerId>/<model>/<dim>" (ab 1.7.0, frei konfigurierbare
-- LLM-/Embedding-Provider). Suche und Duplikat-Check berücksichtigen ausschließlich
-- Zeilen mit der aktuell konfigurierten Signatur — abweichende gelten als „kein
-- Embedding". Damit ist Mischbestand nach einem Modellwechsel strukturell
-- unmöglich statt bloß unwahrscheinlich.
-- Backfill: alle Bestandsvektoren stammen aus OpenAI/text-embedding-3-large/3072.
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS embedding_signature text;
ALTER TABLE postbuch.akte     ADD COLUMN IF NOT EXISTS embedding_signature text;
UPDATE postbuch.postbuch SET embedding_signature = 'openai/text-embedding-3-large/3072'
  WHERE embedding IS NOT NULL AND embedding_signature IS NULL;
UPDATE postbuch.akte     SET embedding_signature = 'openai/text-embedding-3-large/3072'
  WHERE embedding IS NOT NULL AND embedding_signature IS NULL;
CREATE INDEX IF NOT EXISTS postbuch_idx_embedding_signature
  ON postbuch.postbuch USING btree (embedding_signature);

-- Eingangs-/Ausgangspost-Refactor: richtung + Spalten-Renames (alle idempotent)
ALTER TABLE postbuch.postbuch
  ADD COLUMN IF NOT EXISTS richtung postbuch.post_richtung NOT NULL DEFAULT 'eingang';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='postbuch' AND table_name='postbuch'
               AND column_name='absender_name')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='postbuch' AND table_name='postbuch'
                       AND column_name='kontakt') THEN
    ALTER TABLE postbuch.postbuch RENAME COLUMN absender_name TO kontakt;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='postbuch' AND table_name='postbuch'
               AND column_name='adressat')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='postbuch' AND table_name='postbuch'
                       AND column_name='familienmitglied') THEN
    ALTER TABLE postbuch.postbuch RENAME COLUMN adressat TO familienmitglied;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sha256_format_ck') THEN
    ALTER TABLE postbuch.postbuch
      ADD CONSTRAINT sha256_format_ck CHECK ((sha256 IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$'));
  END IF;
END $$;

-- Aufräumen: `simhash` und `full_text` wurden direkt gegen die Produktions-DB
-- angelegt, standen nie in diesem Schema und werden von keiner Codestelle gelesen
-- oder geschrieben (Grep über app/ und web/: 0 Treffer). Reste eines abgebrochenen
-- simhash-Duplikaterkennungs-Experiments; zum Zeitpunkt des Entfernens waren 2 von
-- 328 Zeilen gefüllt, beides redundanter OCR-Text zu weiterhin vorhandenen PDFs.
-- Vorher wurde ein manueller pg_dump gezogen.
DROP INDEX IF EXISTS postbuch.postbuch_idx_simhash;
ALTER TABLE postbuch.postbuch
  DROP COLUMN IF EXISTS simhash,
  DROP COLUMN IF EXISTS full_text;

-- Originalverbleib-Feature (idempotent)
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS verbleib_id INT REFERENCES postbuch.verbleib_kategorie(id);
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS original_urkunde BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS verbleib_ort TEXT;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS verbleib_ablage_id INT REFERENCES postbuch.verbleib_ablage(id);

-- Auto-Migration: bestehende verbleib_ort-Freitexte → strukturierte verbleib_ablage (einmalig, idempotent)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM postbuch.postbuch
    WHERE verbleib_ort IS NOT NULL AND verbleib_ort <> ''
      AND verbleib_id IS NOT NULL AND verbleib_ablage_id IS NULL
  ) THEN
    INSERT INTO postbuch.verbleib_ablage (kategorie_id, name)
    SELECT DISTINCT verbleib_id, verbleib_ort
    FROM postbuch.postbuch
    WHERE verbleib_ort IS NOT NULL AND verbleib_ort <> '' AND verbleib_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    UPDATE postbuch.postbuch p
    SET verbleib_ablage_id = va.id
    FROM postbuch.verbleib_ablage va
    WHERE p.verbleib_id = va.kategorie_id AND p.verbleib_ort = va.name
      AND p.verbleib_ablage_id IS NULL;
  END IF;
END $$;

-- Post-Files (abhängig von postbuch)

CREATE TABLE IF NOT EXISTS postbuch.post_files (
    postid character varying(7) NOT NULL PRIMARY KEY,
    file bytea NOT NULL,
    stored_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Arztrechnung (abhängig von postbuch)

CREATE TABLE IF NOT EXISTS postbuch.arztrechnung (
    postid character varying(7) NOT NULL PRIMARY KEY,
    typ text,
    re_nr text,
    rechnungsdatum date,
    faelligkeit date,
    bezahlt_am date,
    name_arzt text,
    behandelte_person text,
    leistung text,
    gesamtbetrag numeric(12,2),
    iban text,
    verwendungszweck text,
    kontoinhaber text,
    abrechnungsperiode_pkv integer,
    abrechnungsperiode_beihilfe integer,
    pkv_satz_override numeric(5,2),
    beihilfe_satz_override numeric(5,2),
    CONSTRAINT arz_abrechnungsperiode_beihilfe_ck CHECK (((abrechnungsperiode_beihilfe IS NULL) OR (abrechnungsperiode_beihilfe >= 0))),
    CONSTRAINT arz_abrechnungsperiode_pkv_ck CHECK (((abrechnungsperiode_pkv IS NULL) OR (abrechnungsperiode_pkv >= 0)))
);

-- Spalten-Migrationen arztrechnung (idempotent, für Upgrades bestehender Installationen)
ALTER TABLE postbuch.arztrechnung ADD COLUMN IF NOT EXISTS pkv_satz_override numeric(5,2);
ALTER TABLE postbuch.arztrechnung ADD COLUMN IF NOT EXISTS beihilfe_satz_override numeric(5,2);
ALTER TABLE postbuch.arztrechnung ADD COLUMN IF NOT EXISTS bezahlt_am_manuell boolean DEFAULT false NOT NULL;
-- Ein NULL-Wert bedeutet: nicht bestritten. Der Betrag kann bis zur Rechnungssumme
-- gesetzt werden; bei voller Höhe ist aktuell nichts zu zahlen.
ALTER TABLE postbuch.arztrechnung ADD COLUMN IF NOT EXISTS bestritten_betrag numeric(12,2);
DO $$ BEGIN
  ALTER TABLE postbuch.arztrechnung ADD CONSTRAINT arz_bestritten_betrag_ck CHECK (bestritten_betrag IS NULL OR (bestritten_betrag > 0 AND bestritten_betrag <= gesamtbetrag));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Altbestand aus der Vor-LxD-Zeit trug hier den capitalisierten dokumentTyp-Wert
-- (z.B. "Arztrechnung"), neue Zeilen den LxD-Code (z.B. "arztrechnung"). typ ist
-- reines Spiegelfeld von postbuch.dokumentart — vereinheitlicht auf den Code.
UPDATE postbuch.arztrechnung SET typ = lower(typ) WHERE typ IS DISTINCT FROM lower(typ);

-- Spalten-Migrationen akte (idempotent, für Upgrades bestehender Installationen)
ALTER TABLE postbuch.akte ADD COLUMN IF NOT EXISTS historisch boolean DEFAULT false NOT NULL;
ALTER TABLE postbuch.akte ADD COLUMN IF NOT EXISTS dok_sort_mode varchar(20) DEFAULT 'custom' NOT NULL;

-- Arztrechnung-Einzelposition (abhängig von arztrechnung)

CREATE TABLE IF NOT EXISTS postbuch.arztrechnung_einzelposition (
    postid character varying(7) NOT NULL,
    subid integer NOT NULL,
    behandlungs_datum date,
    goa_goz_gebueh_pzn text,
    leistung text,
    begruendung text,
    faktor numeric(5,2),
    betrag numeric(12,2),
    PRIMARY KEY (postid, subid)
);

-- Erstattungsbescheid (abhängig von postbuch)

CREATE TABLE IF NOT EXISTS postbuch.erstattungsbescheid (
    postid character varying(7) NOT NULL PRIMARY KEY,
    kostentraeger text,
    bescheiddatum date,
    erstattungsbetrag numeric(12,2),
    matching_summary text,
    hinweise text
);

-- Persistierte Patientengruppe: ein Tier-PKV-Bescheid darf niemals gegen
-- menschliche Rechnungen gematcht werden (und umgekehrt).
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ist_tier boolean NOT NULL DEFAULT false;

-- LLM-Token-Tracking für Erstattungsbescheid (idempotente ALTER TABLE)
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ai_eb_model text;
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ai_eb_tokens_in integer;
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ai_eb_tokens_out integer;
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ai_eb_cost_usd numeric(12,6);
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ai_kuerzung_model text;
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ai_kuerzung_tokens_in integer;
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ai_kuerzung_tokens_out integer;
ALTER TABLE postbuch.erstattungsbescheid ADD COLUMN IF NOT EXISTS ai_kuerzung_cost_usd numeric(12,6);

-- Erstattungsbescheid-Einzelposition (abhängig von erstattungsbescheid + arztrechnung)

CREATE TABLE IF NOT EXISTS postbuch.erstattungsbescheid_einzelposition (
    postid character varying(7) NOT NULL,
    subid integer NOT NULL,
    arz_postid character varying(7),
    erstattungsbetrag numeric(12,2),
    rechnungsbetrag numeric(12,2),
    kuerzungsbetrag numeric(12,2),
    behandelte_person text,
    kostenart text,
    bezugsdatum date,
    PRIMARY KEY (postid, subid)
);

-- Erstattungsbescheid-Kürzung (abhängig von erstattungsbescheid_einzelposition + arztrechnung_einzelposition)

CREATE TABLE IF NOT EXISTS postbuch.erstattungsbescheid_kuerzung (
    postid character varying(7) NOT NULL,
    eb_subid integer NOT NULL,
    kuerzung_id integer NOT NULL GENERATED ALWAYS AS IDENTITY (
        SEQUENCE NAME postbuch.erstattungsbescheid_kuerzung_kuerzung_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1
    ),
    arz_postid character varying(7),
    arz_subid integer,
    kuerzungsbetrag numeric(12,2) NOT NULL,
    begruendung text,
    PRIMARY KEY (postid, eb_subid, kuerzung_id),
    CONSTRAINT kuerzung_arz_ref_ck CHECK (((arz_subid IS NULL) OR (arz_postid IS NOT NULL)))
);

-- Abrechnungsperiode-Buch (abhängig von erstattungsbescheid)

CREATE TABLE IF NOT EXISTS postbuch.abrechnungsperiode_buch (
    person text NOT NULL,
    kostentraeger text NOT NULL,
    periode integer DEFAULT 1 NOT NULL,
    status postbuch.abrechnungsperiode_status DEFAULT 'COLLECTING'::postbuch.abrechnungsperiode_status NOT NULL,
    eb_postid character varying(7),
    PRIMARY KEY (person, kostentraeger, periode)
);

-- Spalten-Migration abrechnungsperiode_buch: Beihilfe-/PKV-Satz zum Zeitpunkt der Periodenanlage (idempotent)
-- Zweck: Satzänderungen (z. B. bei Renteneintritt) beeinflussen abgeschlossene Perioden nicht rückwirkend.
ALTER TABLE postbuch.abrechnungsperiode_buch ADD COLUMN IF NOT EXISTS satz numeric(5,2);

-- Arztbericht (abhängig von postbuch)

CREATE TABLE IF NOT EXISTS postbuch.arztbericht (
    postid character varying(7) NOT NULL PRIMARY KEY,
    behandelte_person text,
    anlass text,
    norm_befunde text,
    pathologische_befunde text
);

-- Generische Rechnung (abhängig von postbuch)

CREATE TABLE IF NOT EXISTS postbuch.generische_rechnung (
    postid character varying(7) NOT NULL PRIMARY KEY,
    re_nr text,
    rechnungsdatum date,
    gesamtbetrag numeric(12,2),
    absender text,
    bezahlt_am date,
    faelligkeit date,
    iban text,
    verwendungszweck text,
    kontoinhaber text
);

-- Spalten-Migrationen generische_rechnung
ALTER TABLE postbuch.generische_rechnung ADD COLUMN IF NOT EXISTS bezahlt_am_manuell boolean DEFAULT false NOT NULL;
ALTER TABLE postbuch.generische_rechnung ADD COLUMN IF NOT EXISTS bestritten_betrag numeric(12,2);
DO $$ BEGIN
  ALTER TABLE postbuch.generische_rechnung ADD CONSTRAINT gen_bestritten_betrag_ck CHECK (bestritten_betrag IS NULL OR (bestritten_betrag > 0 AND bestritten_betrag <= gesamtbetrag));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Handwerkerrechnung (abhängig von postbuch)

CREATE TABLE IF NOT EXISTS postbuch.handwerkerrechnung (
    postid character varying(7) NOT NULL PRIMARY KEY,
    re_nr text,
    rechnungsdatum date,
    leistungsdatum text,
    faelligkeit date,
    bezahlt_am date,
    name_unternehmen text,
    leistung text,
    gesamtbetrag numeric(12,2),
    lohnkosten numeric(12,2),
    iban text,
    verwendungszweck text
);

-- Spalten-Migrationen handwerkerrechnung
ALTER TABLE postbuch.handwerkerrechnung ADD COLUMN IF NOT EXISTS bezahlt_am_manuell boolean DEFAULT false NOT NULL;
ALTER TABLE postbuch.handwerkerrechnung ADD COLUMN IF NOT EXISTS bestritten_betrag numeric(12,2);
DO $$ BEGIN
  ALTER TABLE postbuch.handwerkerrechnung ADD CONSTRAINT hand_bestritten_betrag_ck CHECK (bestritten_betrag IS NULL OR (bestritten_betrag > 0 AND bestritten_betrag <= gesamtbetrag));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Saldo-Buchung-Manuell (abhängig von saldo)

CREATE TABLE IF NOT EXISTS postbuch.saldo_buchung_manuell (
    buchung_id integer NOT NULL PRIMARY KEY DEFAULT nextval('postbuch.saldo_buchung_manuell_buchung_id_seq'::regclass),
    saldo_id integer NOT NULL,
    datum date NOT NULL,
    zweck text NOT NULL,
    betrag numeric(12,2) NOT NULL,
    saldo_art postbuch.saldo_art NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Saldo-Quelle (abhängig von saldo + postbuch)

CREATE TABLE IF NOT EXISTS postbuch.saldo_quelle (
    quelle_id integer NOT NULL PRIMARY KEY DEFAULT nextval('postbuch.saldo_quelle_quelle_id_seq'::regclass),
    saldo_id integer NOT NULL,
    typ text NOT NULL,
    name text NOT NULL,
    beschreibung text,
    buchungen_sql text NOT NULL,
    saldo_art postbuch.saldo_art NOT NULL,
    postid character varying(7),
    CONSTRAINT saldo_quelle_typ_check CHECK ((typ = ANY (ARRAY['statisch'::text, 'dynamisch'::text])))
);

-- Akte-Dokument (abhängig von akte + postbuch)

CREATE TABLE IF NOT EXISTS postbuch.akte_dokument (
    akteid character varying(7) NOT NULL,
    postid character varying(7) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (akteid, postid)
);

-- Wiedervorlage (abhängig von postbuch + akte)

CREATE TABLE IF NOT EXISTS postbuch.wiedervorlage (
    wv_id integer NOT NULL PRIMARY KEY DEFAULT nextval('postbuch.wiedervorlage_wv_id_seq'::regclass),
    postid character varying(7),
    akteid character varying(7),
    faellig_am date NOT NULL,
    aktion text NOT NULL,
    erledigt boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wv_ref_xor_ck CHECK ((((postid IS NOT NULL) AND (akteid IS NULL)) OR ((postid IS NULL) AND (akteid IS NOT NULL))))
);

-- Marker für Wiedervorlage-Push (verhindert Doppelversand am selben Tag).
ALTER TABLE postbuch.wiedervorlage ADD COLUMN IF NOT EXISTS push_notified_on date;

-- Log für gesendete Zahlungs-Erinnerungs-Pushes
-- (verhindert Doppelversand pro Postid+Offset+Tag, ohne FK auf postbuch — Log bleibt auch bei Löschung erhalten).
CREATE TABLE IF NOT EXISTS postbuch._payment_push_log (
    postid        varchar(7) NOT NULL,
    typ           text NOT NULL,
    offset_days   integer NOT NULL,
    notified_on   date NOT NULL,
    sent_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (postid, offset_days, notified_on)
);
CREATE INDEX IF NOT EXISTS idx_payment_push_log_notified_on
    ON postbuch._payment_push_log (notified_on);

-- ══════════════════════════════════════════════════════════════════
-- INDEXES (IF NOT EXISTS für Idempotenz)
-- ══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_abrechnungsperiode_buch_status ON postbuch.abrechnungsperiode_buch USING btree (kostentraeger, status);
CREATE INDEX IF NOT EXISTS idx_app_log_level ON postbuch.app_log USING btree (level);
CREATE INDEX IF NOT EXISTS idx_app_log_ts ON postbuch.app_log USING btree (ts DESC);
CREATE INDEX IF NOT EXISTS idx_arztrechnung_abrechnungsperiode_beihilfe ON postbuch.arztrechnung USING btree (behandelte_person, abrechnungsperiode_beihilfe) WHERE (abrechnungsperiode_beihilfe IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_arztrechnung_abrechnungsperiode_pkv ON postbuch.arztrechnung USING btree (behandelte_person, abrechnungsperiode_pkv) WHERE (abrechnungsperiode_pkv IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON postbuch._jobs USING btree (status, started_at);
CREATE INDEX IF NOT EXISTS idx_postbuch_historisch ON postbuch.postbuch USING btree (historisch) WHERE (historisch = true);
CREATE INDEX IF NOT EXISTS postbuch_idx_akte_created ON postbuch.akte USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS postbuch_idx_akte_dokument_postid ON postbuch.akte_dokument USING btree (postid);
CREATE INDEX IF NOT EXISTS postbuch_idx_akte_dokument_sort ON postbuch.akte_dokument USING btree (akteid, sort_order);
CREATE INDEX IF NOT EXISTS postbuch_idx_akte_embedding_hnsw ON postbuch.akte USING hnsw (embedding postbuch.halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS postbuch_idx_akte_schlagwoerter_gin ON postbuch.akte USING gin (schlagwoerter);
CREATE INDEX IF NOT EXISTS postbuch_idx_akte_historisch ON postbuch.akte USING btree (historisch) WHERE (historisch = true);
CREATE INDEX IF NOT EXISTS postbuch_idx_akte_updated ON postbuch.akte USING btree (updated_at DESC);
CREATE INDEX IF NOT EXISTS postbuch_idx_ap_person ON postbuch.abrechnungsperiode_buch USING btree (person);
CREATE INDEX IF NOT EXISTS postbuch_idx_briefdatum ON postbuch.postbuch USING btree (briefdatum);
CREATE INDEX IF NOT EXISTS postbuch_idx_eb_arz_postid ON postbuch.erstattungsbescheid_einzelposition USING btree (arz_postid);
CREATE INDEX IF NOT EXISTS postbuch_idx_embedding_hnsw ON postbuch.postbuch USING hnsw (embedding postbuch.halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS postbuch_idx_onedrive_id ON postbuch.postbuch USING btree (onedrive_id);
CREATE INDEX IF NOT EXISTS postbuch_idx_sha256 ON postbuch.postbuch USING btree (sha256) WHERE sha256 IS NOT NULL;
DROP INDEX IF EXISTS postbuch.postbuch_idx_adressat;
CREATE INDEX IF NOT EXISTS postbuch_idx_familienmitglied ON postbuch.postbuch USING btree (familienmitglied) WHERE familienmitglied IS NOT NULL;
CREATE INDEX IF NOT EXISTS postbuch_idx_richtung ON postbuch.postbuch USING btree (richtung);
CREATE INDEX IF NOT EXISTS postbuch_idx_post_files_stored_at ON postbuch.post_files USING btree (stored_at DESC);
CREATE INDEX IF NOT EXISTS postbuch_idx_schlagwoerter_text_gin ON postbuch.postbuch USING gin (schlagwoerter);
CREATE INDEX IF NOT EXISTS postbuch_idx_wv_akteid ON postbuch.wiedervorlage USING btree (akteid) WHERE (akteid IS NOT NULL);
CREATE INDEX IF NOT EXISTS postbuch_idx_wv_erledigt ON postbuch.wiedervorlage USING btree (erledigt, faellig_am);
CREATE INDEX IF NOT EXISTS postbuch_idx_wv_faellig ON postbuch.wiedervorlage USING btree (faellig_am);
CREATE INDEX IF NOT EXISTS postbuch_idx_wv_postid ON postbuch.wiedervorlage USING btree (postid) WHERE (postid IS NOT NULL);
CREATE INDEX IF NOT EXISTS saldo_buchung_manuell_idx_saldo ON postbuch.saldo_buchung_manuell USING btree (saldo_id);
CREATE INDEX IF NOT EXISTS saldo_idx_invisible ON postbuch.saldo USING btree (invisible);
CREATE INDEX IF NOT EXISTS saldo_quelle_idx_saldo ON postbuch.saldo_quelle USING btree (saldo_id);
CREATE INDEX IF NOT EXISTS ui_log_ts_idx ON postbuch.ui_log USING btree (ts DESC);
CREATE INDEX IF NOT EXISTS wiedervorlage_pkey_wv ON postbuch.wiedervorlage USING btree (wv_id);

-- ══════════════════════════════════════════════════════════════════
-- TRIGGER (CREATE OR REPLACE TRIGGER — PostgreSQL 14+)
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE TRIGGER tg_akte_dokument_touch
    AFTER INSERT OR DELETE ON postbuch.akte_dokument
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_akte_dokument_touch();

CREATE OR REPLACE TRIGGER tg_akte_updated_at
    BEFORE UPDATE ON postbuch.akte
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_akte_updated_at();

CREATE OR REPLACE TRIGGER tg_revert_ap_status_on_eb_nulled
    BEFORE UPDATE ON postbuch.abrechnungsperiode_buch
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_revert_ap_status_on_eb_nulled();

CREATE OR REPLACE TRIGGER tg_saldo_buchung_touch
    AFTER INSERT OR DELETE OR UPDATE ON postbuch.saldo_buchung_manuell
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_saldo_buchung_touch();

CREATE OR REPLACE TRIGGER tg_saldo_updated_at
    BEFORE UPDATE ON postbuch.saldo
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_saldo_updated_at();

CREATE OR REPLACE TRIGGER tr_enforce_post_files_retention
    AFTER INSERT ON postbuch.post_files
    FOR EACH ROW EXECUTE FUNCTION postbuch.enforce_post_files_retention();

CREATE OR REPLACE TRIGGER tr_set_abrechnungsperioden
    BEFORE INSERT OR UPDATE ON postbuch.arztrechnung
    FOR EACH ROW EXECUTE FUNCTION postbuch.set_abrechnungsperioden_from_buch();

-- ══════════════════════════════════════════════════════════════════
-- FOREIGN KEY CONSTRAINTS (DO/pg_constraint für Idempotenz)
-- Zuletzt: nach allen Tabellen und Daten (entspricht pg_dump-Verhalten)
-- ══════════════════════════════════════════════════════════════════

-- Phase A: NULL bleibt für den Legacy-Bestand zulässig; sobald die neue Pipeline
-- Lebensbereiche schreibt, schützt der NOT-VALID-FK auch neue oder geänderte Zeilen.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'postbuch_lebensbereich_fkey') THEN
    ALTER TABLE ONLY postbuch.postbuch
      ADD CONSTRAINT postbuch_lebensbereich_fkey
      FOREIGN KEY (lebensbereich) REFERENCES postbuch.lebensbereich(code) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'postbuch_dokumentart_fkey') THEN
    ALTER TABLE ONLY postbuch.postbuch
      ADD CONSTRAINT postbuch_dokumentart_fkey
      FOREIGN KEY (dokumentart) REFERENCES postbuch.dokumentart(code) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'postbuch_art_fkey') THEN
    ALTER TABLE ONLY postbuch.postbuch
      ADD CONSTRAINT postbuch_art_fkey
      FOREIGN KEY (art) REFERENCES postbuch.dokumentart(code) NOT VALID;
  END IF;
END $$;

-- Selbstauflösender LxD-Cutover (Vorbild: person/users-Migration weiter unten).
-- Validiert die drei oben angelegten NOT-VALID-FKs erst, wenn kein Altbestand
-- mehr NULL-Achsen trägt — auf frischen bzw. bereits migrierten Instanzen ist
-- der Gate-Check ein reiner Lesevorgang. Kein CASCADE beim Type-Drop: eine
-- übersehene Abhängigkeit soll sichtbar scheitern statt still mitzureißen.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname IN ('postbuch_lebensbereich_fkey','postbuch_dokumentart_fkey','postbuch_art_fkey')
               AND NOT convalidated)
     AND NOT EXISTS (SELECT 1 FROM postbuch.postbuch WHERE lebensbereich IS NULL OR dokumentart IS NULL)
  THEN
    ALTER TABLE postbuch.postbuch VALIDATE CONSTRAINT postbuch_lebensbereich_fkey;
    ALTER TABLE postbuch.postbuch VALIDATE CONSTRAINT postbuch_dokumentart_fkey;
    ALTER TABLE postbuch.postbuch VALIDATE CONSTRAINT postbuch_art_fkey;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'postbuch' AND t.typname = 'post_art')
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
                     JOIN pg_namespace n ON n.oid = t.typnamespace
                     WHERE n.nspname = 'postbuch' AND t.typname = 'post_art'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname IN ('postbuch_lebensbereich_fkey','postbuch_dokumentart_fkey','postbuch_art_fkey')
                       AND NOT convalidated)
  THEN
    DROP TYPE postbuch.post_art;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'akte_dokument_akteid_fkey') THEN
    ALTER TABLE ONLY postbuch.akte_dokument
      ADD CONSTRAINT akte_dokument_akteid_fkey FOREIGN KEY (akteid) REFERENCES postbuch.akte(akteid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'akte_dokument_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.akte_dokument
      ADD CONSTRAINT akte_dokument_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arztbericht_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.arztbericht
      ADD CONSTRAINT arztbericht_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arztrechnung_einzelposition_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.arztrechnung_einzelposition
      ADD CONSTRAINT arztrechnung_einzelposition_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.arztrechnung(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arztrechnung_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.arztrechnung
      ADD CONSTRAINT arztrechnung_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erstattungsbescheid_einzelposition_arz_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.erstattungsbescheid_einzelposition
      ADD CONSTRAINT erstattungsbescheid_einzelposition_arz_postid_fkey FOREIGN KEY (arz_postid) REFERENCES postbuch.arztrechnung(postid) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erstattungsbescheid_einzelposition_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.erstattungsbescheid_einzelposition
      ADD CONSTRAINT erstattungsbescheid_einzelposition_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.erstattungsbescheid(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erstattungsbescheid_kuerzung_arz_postid_arz_subid_fkey') THEN
    ALTER TABLE ONLY postbuch.erstattungsbescheid_kuerzung
      ADD CONSTRAINT erstattungsbescheid_kuerzung_arz_postid_arz_subid_fkey FOREIGN KEY (arz_postid, arz_subid) REFERENCES postbuch.arztrechnung_einzelposition(postid, subid) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erstattungsbescheid_kuerzung_arz_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.erstattungsbescheid_kuerzung
      ADD CONSTRAINT erstattungsbescheid_kuerzung_arz_postid_fkey FOREIGN KEY (arz_postid) REFERENCES postbuch.arztrechnung(postid) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erstattungsbescheid_kuerzung_postid_eb_subid_fkey') THEN
    ALTER TABLE ONLY postbuch.erstattungsbescheid_kuerzung
      ADD CONSTRAINT erstattungsbescheid_kuerzung_postid_eb_subid_fkey FOREIGN KEY (postid, eb_subid) REFERENCES postbuch.erstattungsbescheid_einzelposition(postid, subid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erstattungsbescheid_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.erstattungsbescheid
      ADD CONSTRAINT erstattungsbescheid_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ap_buch_eb') THEN
    ALTER TABLE ONLY postbuch.abrechnungsperiode_buch
      ADD CONSTRAINT fk_ap_buch_eb FOREIGN KEY (eb_postid) REFERENCES postbuch.erstattungsbescheid(postid) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generische_rechnung_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.generische_rechnung
      ADD CONSTRAINT generische_rechnung_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'handwerkerrechnung_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.handwerkerrechnung
      ADD CONSTRAINT handwerkerrechnung_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_files_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.post_files
      ADD CONSTRAINT post_files_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saldo_buchung_manuell_saldo_id_fkey') THEN
    ALTER TABLE ONLY postbuch.saldo_buchung_manuell
      ADD CONSTRAINT saldo_buchung_manuell_saldo_id_fkey FOREIGN KEY (saldo_id) REFERENCES postbuch.saldo(saldo_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saldo_quelle_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.saldo_quelle
      ADD CONSTRAINT saldo_quelle_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saldo_quelle_saldo_id_fkey') THEN
    ALTER TABLE ONLY postbuch.saldo_quelle
      ADD CONSTRAINT saldo_quelle_saldo_id_fkey FOREIGN KEY (saldo_id) REFERENCES postbuch.saldo(saldo_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiedervorlage_akteid_fkey') THEN
    ALTER TABLE ONLY postbuch.wiedervorlage
      ADD CONSTRAINT wiedervorlage_akteid_fkey FOREIGN KEY (akteid) REFERENCES postbuch.akte(akteid) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiedervorlage_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.wiedervorlage
      ADD CONSTRAINT wiedervorlage_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════
-- PIPELINE-SUSPENSION + FAILED-DOKUMENTE (Duplikat-Entscheidungsflow)
-- Idempotent via CREATE TABLE IF NOT EXISTS
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS postbuch._pipeline_suspensions (
    job_id              uuid PRIMARY KEY REFERENCES postbuch._jobs(id) ON DELETE CASCADE,
    reason              text NOT NULL,
    onedrive_id         text NOT NULL,
    onedrive_weburl     text,
    reserved_postid     varchar(7) NOT NULL,
    match_postid        varchar(7) NOT NULL,
    match_weburl        text,
    match_confidence    numeric,
    similarity          numeric,
    new_confidence      numeric,
    embedding           postbuch.halfvec(3072),
    payload             jsonb NOT NULL,
    step_offset         int NOT NULL DEFAULT 0,
    discord_message_id  text,
    created_at          timestamptz DEFAULT now(),
    expires_at          timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pipeline_suspensions_idx_expires
    ON postbuch._pipeline_suspensions (expires_at);

-- Signatur des gespeicherten Duplikat-Vektors (ab 1.7.0). Eine Suspension, die
-- einen Modellwechsel überlebt, darf ihren alten Vektor nicht weiterverwenden.
ALTER TABLE postbuch._pipeline_suspensions ADD COLUMN IF NOT EXISTS embedding_signature text;

CREATE TABLE IF NOT EXISTS postbuch._failed_documents (
    onedrive_id     text PRIMARY KEY,
    failed_filename text NOT NULL,
    web_url         text,
    reason          text NOT NULL,
    detail          text,
    source_job_id   uuid REFERENCES postbuch._jobs(id) ON DELETE SET NULL,
    failed_at       timestamptz DEFAULT now(),
    betreff         text,
    document_type   text
);

-- Crashfeste Brücke zwischen externem Datei-Move und dem nicht atomar damit
-- koppelbaren Postgres-Insert. Ein Eintrag entsteht VOR jeder destruktiven
-- Pipeline-Aktion und verschwindet erst, wenn DB-Zeile oder _failed-Zustand
-- nachweislich persistiert sind.
CREATE TABLE IF NOT EXISTS postbuch._pipeline_file_journal (
    job_id            uuid PRIMARY KEY,
    postid            varchar(7) NOT NULL,
    storage_id        text NOT NULL,
    storage_backend   text NOT NULL,
    target_folder_id  text,
    desired_filename  text,
    actual_filename   text,
    state             text NOT NULL DEFAULT 'prepared',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pipeline_file_journal_postid_ck CHECK (postid ~ '^P[0-9]{6}$'),
    CONSTRAINT pipeline_file_journal_state_ck CHECK (state IN ('prepared', 'move_intent', 'moved', 'db_complete'))
);

CREATE INDEX IF NOT EXISTS pipeline_file_journal_postid_idx
    ON postbuch._pipeline_file_journal (postid);

-- Selbstauflösend für Instanzen, die eine frühe Fassung des Journals ohne
-- db_complete bereits einmal gestartet hatten.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'postbuch._pipeline_file_journal'::regclass
       AND conname = 'pipeline_file_journal_state_ck'
       AND pg_get_constraintdef(oid) NOT LIKE '%db_complete%'
  ) THEN
    ALTER TABLE postbuch._pipeline_file_journal
      DROP CONSTRAINT pipeline_file_journal_state_ck;
    ALTER TABLE postbuch._pipeline_file_journal
      ADD CONSTRAINT pipeline_file_journal_state_ck
      CHECK (state IN ('prepared', 'move_intent', 'moved', 'db_complete'));
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════
-- STORAGE-ABSTRAKTION (ab 1.7.1) — additiv, kein Rename
--
-- Das Datei-Backend ist ab hier austauschbar (heute nur OneDrive, später
-- zusätzlich Nextcloud). Die alten onedrive_*-Spalten bleiben bewusst stehen
-- und werden vom Code weiter mitgeschrieben: ein RENAME wäre auf der Live-DB
-- ein One-Way-Door — ein Rückschritt auf den vorherigen Commit endete sonst in
-- "column does not exist". Ein späterer Aufräum-Release zieht DROP COLUMN und
-- den PK-Wechsel auf _failed_documents nach.
--
-- ADD COLUMN … NOT NULL DEFAULT '<literal>' ist ab PG 11 metadata-only,
-- also kein Table-Rewrite.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS storage_id       text;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS storage_filename text;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS storage_modified timestamptz;
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS storage_backend  text NOT NULL DEFAULT 'onedrive';

-- Backfill (idempotent — greift nur für noch nicht übertragene Zeilen)
UPDATE postbuch.postbuch SET storage_id = onedrive_id
  WHERE storage_id IS NULL AND onedrive_id IS NOT NULL;
UPDATE postbuch.postbuch SET storage_filename = onedrive_filename
  WHERE storage_filename IS NULL AND onedrive_filename IS NOT NULL;
UPDATE postbuch.postbuch SET storage_modified = onedrive_modified
  WHERE storage_modified IS NULL AND onedrive_modified IS NOT NULL;

CREATE INDEX IF NOT EXISTS postbuch_idx_storage_id
  ON postbuch.postbuch USING btree (storage_id);

-- Beide Tabellen halten Backend-Referenzen ohne Marker; ohne storage_backend
-- zeigten nach einer Migration alle offenen Duplikat-Entscheidungen und alle
-- Fehler-Dokumente ins Leere.
ALTER TABLE postbuch._pipeline_suspensions ADD COLUMN IF NOT EXISTS storage_id      text;
ALTER TABLE postbuch._pipeline_suspensions ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'onedrive';
UPDATE postbuch._pipeline_suspensions SET storage_id = onedrive_id
  WHERE storage_id IS NULL AND onedrive_id IS NOT NULL;

ALTER TABLE postbuch._failed_documents ADD COLUMN IF NOT EXISTS storage_id      text;
ALTER TABLE postbuch._failed_documents ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'onedrive';
UPDATE postbuch._failed_documents SET storage_id = onedrive_id
  WHERE storage_id IS NULL AND onedrive_id IS NOT NULL;

-- Der alte PK auf onedrive_id bleibt bis zum Aufräum-Release; die künftige
-- Identität ist (storage_backend, storage_id).
CREATE UNIQUE INDEX IF NOT EXISTS failed_documents_uq_storage
  ON postbuch._failed_documents USING btree (storage_backend, storage_id);

ALTER TABLE postbuch._dr_sessions ADD COLUMN IF NOT EXISTS backend text NOT NULL DEFAULT 'onedrive';

-- Aktives Backend + Ordner-IDs je Backend.
-- _settings.onedrive_folders (flach) wird einmalig nach
-- _settings.storage_folders = { "onedrive": {…} } gehoben. Das Original bleibt
-- als Rückfallebene stehen, wird aber nicht mehr gelesen oder geschrieben.
INSERT INTO postbuch._settings (key, value, updated_at)
  VALUES ('storage_backend', '"onedrive"'::jsonb, now())
  ON CONFLICT (key) DO NOTHING;

INSERT INTO postbuch._settings (key, value, updated_at)
  SELECT 'storage_folders', jsonb_build_object('onedrive', value), now()
    FROM postbuch._settings WHERE key = 'onedrive_folders'
  ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS postbuch._scan_retry_queue (
  job_id            uuid PRIMARY KEY,
  original_filename text NOT NULL,
  local_file_path   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  next_retry_at     timestamptz NOT NULL,
  retry_count       int NOT NULL DEFAULT 0,
  max_retries       int NOT NULL DEFAULT 10,
  last_error        text,
  status            text NOT NULL DEFAULT 'pending',
  CONSTRAINT scan_retry_status_ck CHECK (status IN ('pending', 'manual_only'))
);

-- Migration _scan_retry_queue (idempotent): Bestandskunden, die die Tabelle bereits
-- vor diesem Schema-Stand angelegt haben, auf den Master-Stand angleichen.
-- created_at -> NOT NULL DEFAULT now() (etwaige NULLs vorher backfillen)
UPDATE postbuch._scan_retry_queue SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE postbuch._scan_retry_queue ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE postbuch._scan_retry_queue ALTER COLUMN created_at SET NOT NULL;
-- CHECK-Constraint nachrüsten, falls im Altbestand nicht vorhanden
ALTER TABLE postbuch._scan_retry_queue DROP CONSTRAINT IF EXISTS scan_retry_status_ck;
ALTER TABLE postbuch._scan_retry_queue
  ADD CONSTRAINT scan_retry_status_ck CHECK (status IN ('pending', 'manual_only'));

-- ══════════════════════════════════════════════════════════════════
-- LLM-Call-Log (Token-Kosten-Tracking)
-- ══════════════════════════════════════════════════════════════════
-- Jeder LLM-Aufruf (Anthropic / OpenAI) wird hier protokolliert. Spalten:
--   tokens_in   → Input-Tokens (vom Provider gemeldet)
--   tokens_out  → Output-Tokens
--   cost_usd    → Berechnete Kosten (NULL falls Modell-Preise unbekannt)
--   kategorie   → preanalysis | analysis | erstattungsbescheid | kuerzung | embedding | other
--   entity / entity_id  → Optionaler Kontext (z. B. postbuch + P000123)
--   correlation_id      → Gruppiert zusammengehörige Calls eines Vorgangs
CREATE TABLE IF NOT EXISTS postbuch.llm_call_log (
    id              bigserial PRIMARY KEY,
    ts              timestamptz NOT NULL DEFAULT now(),
    username        text,
    kategorie       text NOT NULL,
    provider        text NOT NULL,
    model           text NOT NULL,
    tokens_in       integer,
    tokens_out      integer,
    cache_creation_tokens integer,
    cache_read_tokens     integer,
    cost_usd        numeric(12, 8),
    cost_usd_notional numeric(12, 8),
    duration_ms     integer,
    success         boolean NOT NULL DEFAULT true,
    error_message   text,
    entity          text,
    entity_id       text,
    correlation_id  text
);

-- Cache-Token-Spalten für Bestands-DBs nachziehen (CREATE TABLE IF NOT EXISTS legt
-- auf einer existierenden Tabelle keine Spalten nach). MUSS nach dem CREATE stehen.
ALTER TABLE postbuch.llm_call_log ADD COLUMN IF NOT EXISTS cache_creation_tokens integer;
ALTER TABLE postbuch.llm_call_log ADD COLUMN IF NOT EXISTS cache_read_tokens     integer;
-- Fiktive API-Kosten für Abo-Calls (Pauschaltarif): cost_usd bleibt 0 (real nichts
-- berechnet), cost_usd_notional hält das API-Äquivalent für die getrennte Anzeige/Summe.
ALTER TABLE postbuch.llm_call_log ADD COLUMN IF NOT EXISTS cost_usd_notional numeric(12, 8);

CREATE INDEX IF NOT EXISTS idx_llm_call_log_ts            ON postbuch.llm_call_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_call_log_kategorie     ON postbuch.llm_call_log (kategorie, ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_call_log_correlation   ON postbuch.llm_call_log (correlation_id, ts);
CREATE INDEX IF NOT EXISTS idx_llm_call_log_entity        ON postbuch.llm_call_log (entity, entity_id);

-- ══════════════════════════════════════════════════════════════════
-- BÜROASSISTENT (Agentischer RAG-Chatbot)
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS postbuch.chat_conversations (
    id          bigserial PRIMARY KEY,
    username    text NOT NULL,
    title       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_conversations_username_idx
    ON postbuch.chat_conversations (username, created_at DESC);

CREATE TABLE IF NOT EXISTS postbuch.chat_messages (
    id                bigserial PRIMARY KEY,
    conversation_id   bigint NOT NULL,
    role              text NOT NULL CHECK (role IN ('user', 'assistant')),
    content           text NOT NULL,
    sources           jsonb,
    cost_usd          numeric(12,8),
    research_model    text,
    synthesis_model   text,
    correlation_id    text,
    billing           text,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_conv_idx
    ON postbuch.chat_messages (conversation_id, created_at);

-- billing: Abrechnungsschiene der Antwort ('subscription' = Abo/Pauschaltarif,
-- 'api' = pro Token). Nachträglich additiv für bestehende Instanzen.
ALTER TABLE postbuch.chat_messages ADD COLUMN IF NOT EXISTS billing text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_conv_fkey') THEN
    ALTER TABLE ONLY postbuch.chat_messages
      ADD CONSTRAINT chat_messages_conv_fkey FOREIGN KEY (conversation_id)
        REFERENCES postbuch.chat_conversations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Aktionen, die der Chat-Assistent an Akten/Dokumenten ausgeführt oder (bei
-- destruktiven Operationen) zur Bestätigung vorgemerkt hat. Pro Assistenten-
-- Antwort (message_id) mehrere Zeilen; jede trägt eine inverse Operation
-- (undo_payload) für den „Rückgängig"-Button und — solange status='pending' —
-- eine exec_payload für die Ausführung nach Nutzerbestätigung.
--   status: 'pending' (destruktiv, wartet auf Bestätigung)
--         | 'done'    (ausgeführt, rückgängig-fähig)
--         | 'undone'  (rückgängig gemacht)
CREATE TABLE IF NOT EXISTS postbuch.chat_agent_action (
    id            bigserial PRIMARY KEY,
    message_id    bigint NOT NULL REFERENCES postbuch.chat_messages(id) ON DELETE CASCADE,
    seq           integer NOT NULL DEFAULT 0,
    action_type   text NOT NULL,
    status        text NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'undone')),
    description   text,
    exec_payload  jsonb,
    undo_payload  jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_agent_action_msg_idx
    ON postbuch.chat_agent_action (message_id, seq);

CREATE TABLE IF NOT EXISTS postbuch.document_text_cache (
    postid            varchar(7) PRIMARY KEY,
    extracted_text    text,
    extraction_method text CHECK (extraction_method IN ('ghostscript', 'llm_vision', 'not_extractable')),
    extracted_at      timestamptz NOT NULL DEFAULT now(),
    char_count        integer
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_text_cache_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.document_text_cache
      ADD CONSTRAINT document_text_cache_postid_fkey FOREIGN KEY (postid)
        REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

-- ── MCP-Zugriffstokens (Bearer-Auth für externe KI-Agenten, z.B. Claude Desktop) ──
-- Speichert NIE den Klartext, nur SHA256(token). Der Klartext wird bei der
-- Erstellung einmalig an den erzeugenden Nutzer zurückgegeben und danach verworfen.
-- username = Prinzipal des Tokens: entweder der ENV-Sonderuser „admin" oder ein
-- schreibberechtigter DB-Nutzer (vollzugriff), der sich ein eigenes Token anlegt.
--
-- Bewusst KEIN Fremdschlüssel auf postbuch.mensch: der Sonder-Nutzer „admin" ist
-- ENV-basiert und existiert NICHT als Mensch (siehe routes/auth.js) — ein FK
-- würde admin-eigene Tokens unmöglich machen. Die Gültigkeit des Prinzipals wird
-- stattdessen bei jedem Request frisch in middleware/mcp-auth.js geprüft
-- (admin-Sonderfall + Lookup in mensch), was zugleich den sofortigen Widerruf
-- beim Löschen eines Menschen sicherstellt.
CREATE TABLE IF NOT EXISTS postbuch.mcp_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username     text NOT NULL,
    token_hash   text NOT NULL UNIQUE,          -- SHA256(token), nie Klartext
    description  text,                          -- z.B. "Claude Desktop"
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at   timestamptz,                   -- NULL = unbegrenzt
    active       boolean NOT NULL DEFAULT true
);
ALTER TABLE postbuch.mcp_tokens ADD COLUMN IF NOT EXISTS mensch_id uuid;
CREATE INDEX IF NOT EXISTS mcp_tokens_username_idx ON postbuch.mcp_tokens (username);
CREATE INDEX IF NOT EXISTS mcp_tokens_mensch_id_idx ON postbuch.mcp_tokens (mensch_id);
UPDATE postbuch.mcp_tokens t SET mensch_id = m.id
  FROM postbuch.mensch m
 WHERE t.mensch_id IS NULL AND t.username <> 'admin'
   AND m.anmeldename = t.username;

-- ══════════════════════════════════════════════════════════════════════════════
-- STORAGE-MIGRATION (Phase 4) — Umzug der Ablage zwischen den Backends
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Zwei Tabellen, analog zum Gespann _jobs/_dr_sessions:
--
--   _storage_migration_runs   der Lauf. Überlebt einen Container-Neustart und
--                             trägt die Restliste-Semantik. Muss eine eigene
--                             Entität sein: jobs/tracker.js:init() setzt beim
--                             App-Start ALLE laufenden _jobs auf 'interrupted',
--                             und beim Resume entsteht ein NEUER Tracker-Job für
--                             denselben Lauf. Lauf-Identität ≠ Job-Identität.
--
--   _storage_migration_items  eine Zeile je Dokument je Lauf.
--
-- src_backend/dst_backend stehen am LAUF, nicht am Item — sie sind für alle
-- Items eines Laufs identisch.
--
-- Bewusst KEIN CHECK-Constraint auf status: ein CHECK in einem idempotenten
-- Vollschema erzwingt DROP+ADD gegen die Live-DB, sobald ein Statuswert
-- dazukommt. Dasselbe Muster wie _jobs.status und _dr_sessions.status — die
-- erlaubten Werte stehen als Konstante in service/storage-migration.js.
--
-- job_id ist ON DELETE SET NULL (nicht CASCADE): der Lauf ist eine dauerhafte
-- Aufzeichnung, die eine aufgeräumte _jobs-Zeile überleben soll. Präzedenzfall
-- ist _failed_documents.source_job_id.
CREATE TABLE IF NOT EXISTS postbuch._storage_migration_runs (
    id            uuid PRIMARY KEY,
    job_id        uuid REFERENCES postbuch._jobs(id) ON DELETE SET NULL,
    src_backend   text NOT NULL,
    dst_backend   text NOT NULL,
    -- 'trockenlauf' | 'laeuft' | 'pausiert' | 'abgeschlossen'
    -- | 'abgeschlossen_mit_resten' | 'abgebrochen' | 'fehler'
    status        text NOT NULL DEFAULT 'trockenlauf',
    stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Quelle aufgeraeumt (Schritt 6) — Zeitpunkt, sonst NULL.
    cleaned_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    error_message text
);

CREATE INDEX IF NOT EXISTS storage_migration_runs_idx_status
    ON postbuch._storage_migration_runs USING btree (status);

-- ON DELETE CASCADE auf postid: die Restlisten-Option „DB-Eintrag löschen"
-- löscht sonst gegen einen Fremdschlüssel. Konsistent mit jedem anderen
-- besessenen Kind von postbuch.postbuch (akte_dokument, arztrechnung, …).
CREATE TABLE IF NOT EXISTS postbuch._storage_migration_items (
    run_id       uuid NOT NULL
                 REFERENCES postbuch._storage_migration_runs(id) ON DELETE CASCADE,
    postid       character varying(7) NOT NULL
                 REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE,
    src_id       text,
    src_link     text,
    src_name     text,
    dst_id       text,
    dst_link     text,
    dst_name     text,
    dst_folder_id text,
    sha256       text,
    -- 'offen' | 'kopiert' | 'fertig' | 'fehler' | 'hash_konflikt'
    -- | 'quelle_fehlt' | 'kein_zielordner' | 'ohne_datei' | 'uebersprungen'
    --
    -- Die Zwischenstufe 'kopiert' ist nicht kosmetisch: dst_id wird UNMITTELBAR
    -- nach dem Upload persistiert, vor Re-Download/Verify. Ein Crash dazwischen
    -- hinterlässt sonst eine verwaiste Zielkopie, die der Resume nur noch per
    -- Namenssuche fände.
    status       text NOT NULL DEFAULT 'offen',
    versuche     integer NOT NULL DEFAULT 0,
    fehler_text  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, postid)
);

-- Resume-Pfad: „alle offenen/fehlerhaften Zeilen dieses Laufs".
CREATE INDEX IF NOT EXISTS storage_migration_items_idx_run_status
    ON postbuch._storage_migration_items USING btree (run_id, status);

-- Laufübergreifende Restliste (Dashboard-Hinweis).
CREATE INDEX IF NOT EXISTS storage_migration_items_idx_rest
    ON postbuch._storage_migration_items USING btree (status)
    WHERE status IN ('fehler', 'hash_konflikt', 'quelle_fehlt', 'kein_zielordner');

CREATE INDEX IF NOT EXISTS storage_migration_items_idx_postid
    ON postbuch._storage_migration_items USING btree (postid);
