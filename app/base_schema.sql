-- base_schema.sql — Idempotentes Vollschema für postbuch
--
-- Diese Datei beschreibt, wie das Schema HEUTE aussieht. Sie ist bewusst keine
-- Chronik: sie enthält keinen einzigen Schritt, der nur dazu dient, eine ältere
-- Datenbank nachzuziehen. Wer wissen will, wie eine Tabelle aufgebaut ist, liest
-- ihre CREATE TABLE — und sonst nichts.
--
-- Wird bei JEDEM Container-Start ausgeführt (via docker-entrypoint.sh). Alle
-- Statements sind idempotent (IF NOT EXISTS / CREATE OR REPLACE / DO…EXCEPTION);
-- eine bestehende Produktions-DB bleibt dabei unverändert.
--
-- ── Wo die Historie geblieben ist ───────────────────────────────────────────
-- Bis Version 2.7.2 standen Zustandsbeschreibung und Migrationshistorie hier
-- gemeinsam, chronologisch angewachsen. Mit dem Baseline-Schnitt liegt alles
-- Historische eingefroren in app/schema/legacy-bis-2.7.2.sql. Der Entrypoint
-- fährt offene Legacy-Skripte in Versionsreihenfolge, bevor er diese Datei
-- anwendet, und verbucht das in postbuch._schema_historie; eine Erstinstallation
-- überspringt sie, weil dieses Vollschema den Zielzustand bereits vollständig
-- erzeugt. Vorbild sind Flyway-Baseline und Rails (db:schema:load für neue
-- Datenbanken, db:migrate für bestehende).
--
-- ── Beim Ändern ─────────────────────────────────────────────────────────────
-- Neue Spalten gehören in ihre CREATE TABLE UND als ALTER TABLE … ADD COLUMN IF
-- NOT EXISTS darunter — sonst bekommt eine bestehende Instanz sie nie. Diese
-- Nachrüst-Statements sind genau die Historie, die beim nächsten Schnitt wieder
-- ins dann neue Legacy-Skript wandert und hier verschwindet. Ablauf des Schnitts
-- steht in CLAUDE.md, Abschnitt „Schema-Migrationen".

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
  -- 'WaitingForAIReview' ist stillgelegt und wird von keiner Stelle mehr
  -- vergeben (siehe app/src/lib/post-status.js). Der Wert bleibt im Enum
  -- stehen, weil Postgres Enum-Werte nicht entfernen kann und Neuinstallation
  -- und Bestandsdatenbank denselben Typ haben müssen.
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

-- Eine Erstattungszuordnung ist fachlicher Bestand und darf beim Löschen einer
-- Arztrechnung nicht durch die SET-NULL-FKs still entwertet werden. Die
-- Anwendung prüft vor dem Datei-Move freundlich; dieser Trigger ist die nicht
-- umgehbare letzte Schutzlinie für Import-, Recovery- und Adminpfade.
CREATE OR REPLACE FUNCTION postbuch.fn_block_arz_delete_with_eb() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  eb_ids text;
BEGIN
  SELECT string_agg(x.eb_postid, ', ' ORDER BY x.eb_postid)
    INTO eb_ids
    FROM (
      SELECT ep.postid AS eb_postid
        FROM postbuch.erstattungsbescheid_einzelposition ep
       WHERE ep.arz_postid = OLD.postid
      UNION
      SELECT k.postid AS eb_postid
        FROM postbuch.erstattungsbescheid_kuerzung k
       WHERE k.arz_postid = OLD.postid
    ) x;

  IF eb_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'arztrechnung_eb_delete_guard',
      MESSAGE = format(
        'Arztrechnung %s kann nicht gelöscht werden: Erstattungsbescheid-Verknüpfung %s',
        OLD.postid, eb_ids
      ),
      HINT = 'Die Zuordnung zuerst im Erstattungsbescheid lösen.';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION postbuch.fn_block_arz_position_delete_with_eb() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  eb_ids text;
BEGIN
  SELECT string_agg(DISTINCT k.postid, ', ' ORDER BY k.postid)
    INTO eb_ids
    FROM postbuch.erstattungsbescheid_kuerzung k
   WHERE k.arz_postid = OLD.postid AND k.arz_subid = OLD.subid;

  IF eb_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'arztrechnung_position_eb_delete_guard',
      MESSAGE = format(
        'Position %s/%s kann nicht gelöscht werden: Erstattungsbescheid-Verknüpfung %s',
        OLD.postid, OLD.subid, eb_ids
      ),
      HINT = 'Die Positionszuordnung zuerst im Erstattungsbescheid lösen.';
  END IF;
  RETURN OLD;
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
    -- Erzeugte Artefakte (Merge-PDF, Chunks) als JSONB-Liste von
    -- {typ, sortierung, storage_backend, storage_id, dateiname} — je Session
    -- nur eine Handvoll kleiner Einträge, nie relational gejoint, daher
    -- bewusst keine eigene Tabelle.
    artefakte jsonb NOT NULL DEFAULT '[]'::jsonb,
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

-- Instanzen, die diese Tabelle noch ohne Primärschlüssel angelegt haben,
-- bekommen ihn hier nachgereicht: `CREATE TABLE IF NOT EXISTS` rüstet eine
-- fehlende Bedingung nicht nach, sodass Erstinstallation und gewachsene
-- Datenbank sonst dauerhaft auseinanderlaufen. Ohne den Schlüssel sind
-- doppelte Marker möglich, und ein künftiges `ON CONFLICT (name)` liefe auf
-- frischen Installationen sauber und bräche auf gewachsenen. Eventuelle
-- Dubletten werden vorher auf die zuerst geschriebene Zeile eingedampft.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'postbuch._migrations'::regclass AND contype = 'p'
  ) THEN
    DELETE FROM postbuch._migrations a
     USING postbuch._migrations b
     WHERE a.name = b.name AND a.ctid > b.ctid;
    ALTER TABLE postbuch._migrations
      ADD CONSTRAINT _migrations_pkey PRIMARY KEY (name);
  END IF;
END $$;

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
ALTER TABLE postbuch._backup_metadata ADD COLUMN IF NOT EXISTS encrypted boolean NOT NULL DEFAULT false;

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
    error_message text,
    backend text NOT NULL DEFAULT 'onedrive'
);

CREATE TABLE IF NOT EXISTS postbuch._settings (
    key text NOT NULL PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

-- Semantischer Hilfekorpus des Büroassistenten. Ein neuer Korpus wird zunächst
-- vollständig aufgebaut und erst danach atomar aktiviert. So bleibt bei einem
-- Update oder vorübergehend nicht erreichbaren Embedding-Provider der letzte
-- vollständige Stand erhalten. `korpus_id` bindet Dokumentationshash und
-- Embedding-Signatur zusammen; Vektoren verschiedener Modelle werden nie
-- miteinander verglichen.
CREATE TABLE IF NOT EXISTS postbuch._hilfe_korpus (
    korpus_id           character(64) PRIMARY KEY,
    dokument_hash       character(64) NOT NULL,
    app_version         text,
    embedding_signature text NOT NULL,
    status              text NOT NULL DEFAULT 'wird_erstellt'
                        CHECK (status IN ('wird_erstellt', 'bereit', 'fehlgeschlagen')),
    aktiv               boolean NOT NULL DEFAULT false,
    abschnitt_anzahl    integer NOT NULL DEFAULT 0,
    fehler              text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    CONSTRAINT hilfe_korpus_dokument_hash_ck CHECK (dokument_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT hilfe_korpus_id_ck CHECK (korpus_id ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS hilfe_korpus_ein_aktiver_idx
    ON postbuch._hilfe_korpus (aktiv) WHERE aktiv = true;
CREATE INDEX IF NOT EXISTS hilfe_korpus_signatur_idx
    ON postbuch._hilfe_korpus (embedding_signature, completed_at DESC);

CREATE TABLE IF NOT EXISTS postbuch._hilfe_abschnitt (
    korpus_id           character(64) NOT NULL
                        REFERENCES postbuch._hilfe_korpus(korpus_id) ON DELETE CASCADE,
    abschnitt_id        text NOT NULL,
    kapitel             text NOT NULL,
    kapitel_titel       text NOT NULL,
    ueberschrift        text NOT NULL,
    anker               text,
    route               text NOT NULL,
    sort_order          integer NOT NULL,
    inhalt              text NOT NULL,
    inhalt_hash         character(64) NOT NULL,
    embedding           postbuch.halfvec(3072) NOT NULL,
    embedding_signature text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (korpus_id, abschnitt_id),
    CONSTRAINT hilfe_abschnitt_inhalt_hash_ck CHECK (inhalt_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT hilfe_abschnitt_route_ck CHECK (route ~ '^/hilfe(/[a-z0-9][a-z0-9-]*)?(#[^[:space:]]+)?$')
);
CREATE INDEX IF NOT EXISTS hilfe_abschnitt_signatur_idx
    ON postbuch._hilfe_abschnitt (embedding_signature, korpus_id);
CREATE INDEX IF NOT EXISTS hilfe_abschnitt_route_idx
    ON postbuch._hilfe_abschnitt (route);

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

-- Mensch — die einzige Identitätstabelle (fachliche Person UND App-Zugang).
--
-- Die früheren Tabellen `person` (fachlich) und `users` (Login) sind abgelöst
-- und gelöscht; das Heben der Altbestände erledigt das Legacy-Skript. Referenziert
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
    -- Ein Tier bleibt im etablierten Menschenmodell, damit keine zweite große
    -- Identitätsmigration an LxD gekoppelt wird.
    ist_tier boolean NOT NULL DEFAULT false,
    CONSTRAINT mensch_pkv_satz_ck CHECK (pkv_satz IS NULL OR (pkv_satz >= 0 AND pkv_satz <= 100)),
    CONSTRAINT mensch_beihilfe_satz_ck CHECK (beihilfe_satz IS NULL OR (beihilfe_satz >= 0 AND beihilfe_satz <= 100)),
    CONSTRAINT mensch_tier_keine_beihilfe_ck CHECK (NOT ist_tier OR NOT beihilfe),
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

-- Anmeldenamen sind ohne Rücksicht auf Groß-/Kleinschreibung eindeutig; der
-- Login vergleicht ebenso. Enthält ein Bestand bereits kollidierende Namen,
-- bleibt der Index aus (Hinweis statt Startabbruch); routes/menschen.js
-- verhindert neue Kollisionen unabhängig davon.
DO $$
DECLARE
  v_kollisionen integer;
BEGIN
  SELECT count(*) INTO v_kollisionen FROM (
    SELECT lower(anmeldename) FROM postbuch.mensch
     WHERE anmeldename IS NOT NULL
     GROUP BY lower(anmeldename) HAVING count(*) > 1
  ) k;
  IF v_kollisionen = 0 THEN
    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS mensch_anmeldename_lower_uq
        ON postbuch.mensch (lower(anmeldename)) WHERE anmeldename IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'mensch_anmeldename_lower_uq übersprungen: Kollision beim Anlegen';
    END;
  ELSE
    RAISE NOTICE 'mensch_anmeldename_lower_uq übersprungen: % Anmeldenamen kollidieren ohne Groß-/Kleinschreibung', v_kollisionen;
  END IF;
END $$;

-- Aktivität und vorhandene Zugangsdaten sind getrennte Zustände: ein
-- deaktivierter Zugang darf seine Credentials behalten, damit eine spätere
-- Reaktivierung möglich bleibt. Bestehende Installationen erhalten dieselbe
-- Constraint-Definition idempotent.
DO $$
BEGIN
  ALTER TABLE postbuch.mensch DROP CONSTRAINT IF EXISTS mensch_login_ck;
  ALTER TABLE postbuch.mensch ADD CONSTRAINT mensch_login_ck CHECK (
    NOT loginfaehig OR (anmeldename IS NOT NULL AND password_hash IS NOT NULL AND rolle IS NOT NULL)
  );
END $$;

-- Lesebereich: 'eigene' beschränkt einen Lesezugriff auf Dokumente, deren
-- familienmitglied der eigene Kurzname ist. Default 'alle' = bisheriges Verhalten.
-- Nur mit Rolle lesezugriff sinnvoll; routes/menschen.js setzt sonst 'alle'.
ALTER TABLE postbuch.mensch
  ADD COLUMN IF NOT EXISTS lesebereich text NOT NULL DEFAULT 'alle';

DO $$
BEGIN
  ALTER TABLE postbuch.mensch DROP CONSTRAINT IF EXISTS mensch_lesebereich_ck;
  ALTER TABLE postbuch.mensch ADD CONSTRAINT mensch_lesebereich_ck CHECK (
    lesebereich = 'alle' OR (lesebereich = 'eigene' AND rolle = 'lesezugriff')
  );
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
    embedding_signature text,
    historisch boolean DEFAULT false NOT NULL,
    dok_sort_mode varchar(20) DEFAULT 'custom' NOT NULL,
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
    -- LxD-Achsen: Lebensbereich × Dokumentart (FKs stehen im FK-Abschnitt).
    lebensbereich text,
    dokumentart text,
    -- Embedding-Fehler-Tracking (Soft-Fail: Dokument landet in der DB, aber ohne
    -- Embedding). Gesetzt, wenn fetchEmbeddingForExtractedData() in der Pipeline
    -- wirft; gelöscht, sobald storeEmbedding() erfolgreich war.
    embedding_failed_at timestamptz,
    embedding_error text,
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
    data_repaired_at timestamptz,
    data_repairs jsonb,
    -- Embedding-Signatur "<providerId>/<model>/<dim>" (ab 1.7.0). Suche und
    -- Duplikat-Check berücksichtigen ausschließlich Zeilen mit der aktuell
    -- konfigurierten Signatur — abweichende gelten als „kein Embedding". Damit ist
    -- Mischbestand nach einem Modellwechsel strukturell unmöglich statt bloß
    -- unwahrscheinlich.
    embedding_signature text,
    -- Originalverbleib: Kategorie + physische Ablage des Papieroriginals.
    verbleib_id integer REFERENCES postbuch.verbleib_kategorie(id),
    original_urkunde boolean NOT NULL DEFAULT false,
    verbleib_ort text,
    verbleib_ablage_id integer REFERENCES postbuch.verbleib_ablage(id),
    -- Storage-Abstraktion (ab 1.7.1): gelesen wird ausschließlich aus storage_*,
    -- geschrieben zusätzlich in die onedrive_*-Spalten darüber. Deren Abbau ist
    -- einem späteren Aufräum-Release vorbehalten.
    storage_id text,
    storage_filename text,
    storage_modified timestamptz,
    storage_backend text NOT NULL DEFAULT 'onedrive',
    CONSTRAINT confidence_ck CHECK (((confidence >= 0.00) AND (confidence <= 1.00))),
    CONSTRAINT link_url_ck CHECK (((link IS NULL) OR (link ~ '^https?://'::text))),
    CONSTRAINT postid_format_ck CHECK (((postid)::text ~ '^P[0-9]{6}$'::text)),
    CONSTRAINT sha256_format_ck CHECK ((sha256 IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$'))
);
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
    updated_at timestamptz NOT NULL DEFAULT now(),
    nachpruefung boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS lxd_migration_items_status_idx
  ON postbuch._lxd_migration_items(status);
CREATE INDEX IF NOT EXISTS postbuch_idx_embedding_signature
  ON postbuch.postbuch USING btree (embedding_signature);

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
    bezahlt_am_manuell boolean DEFAULT false NOT NULL,
    -- NULL bedeutet: nicht bestritten. Der Betrag kann bis zur Rechnungssumme
    -- gesetzt werden; bei voller Höhe ist aktuell nichts zu zahlen.
    bestritten_betrag numeric(12,2),
    CONSTRAINT arz_bestritten_betrag_ck CHECK (bestritten_betrag IS NULL OR (bestritten_betrag > 0 AND bestritten_betrag <= gesamtbetrag)),
    CONSTRAINT arz_abrechnungsperiode_beihilfe_ck CHECK (((abrechnungsperiode_beihilfe IS NULL) OR (abrechnungsperiode_beihilfe >= 0))),
    CONSTRAINT arz_abrechnungsperiode_pkv_ck CHECK (((abrechnungsperiode_pkv IS NULL) OR (abrechnungsperiode_pkv >= 0)))
);

-- Feature "Rechnungsteile": welcher Seitenbereich des gespeicherten Originals
-- beim Zusammenstellen von Kostenträger-Einreichungen verwendet wird
-- (Deckblatt/Duplikat werden so gefiltert, ohne das gespeicherte Original zu
-- verändern). Immer gemeinsam gesetzt; NULL/NULL = ganzes Dokument.
-- CREATE TABLE oben läuft auf Bestandsinstanzen nie erneut — neue Spalten
-- daher per ADD COLUMN IF NOT EXISTS, die Constraint-Definition idempotent
-- über DROP+ADD in einem DO-Block.
ALTER TABLE postbuch.arztrechnung ADD COLUMN IF NOT EXISTS einreichung_seite_von integer;
ALTER TABLE postbuch.arztrechnung ADD COLUMN IF NOT EXISTS einreichung_seite_bis integer;
DO $$
BEGIN
  ALTER TABLE postbuch.arztrechnung DROP CONSTRAINT IF EXISTS arz_einreichung_seiten_ck;
  ALTER TABLE postbuch.arztrechnung ADD CONSTRAINT arz_einreichung_seiten_ck CHECK (
    (einreichung_seite_von IS NULL AND einreichung_seite_bis IS NULL)
    OR (einreichung_seite_von IS NOT NULL AND einreichung_seite_bis IS NOT NULL
        AND einreichung_seite_von >= 1 AND einreichung_seite_bis >= einreichung_seite_von)
  );
END $$;

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
    hinweise text,
    -- Persistierte Patientengruppe: ein Tier-PKV-Bescheid darf niemals gegen
    -- menschliche Rechnungen gematcht werden (und umgekehrt).
    ist_tier boolean NOT NULL DEFAULT false,
    -- LLM-Token-Tracking
    ai_eb_model text,
    ai_eb_tokens_in integer,
    ai_eb_tokens_out integer,
    ai_eb_cost_usd numeric(12,6),
    ai_kuerzung_model text,
    ai_kuerzung_tokens_in integer,
    ai_kuerzung_tokens_out integer,
    ai_kuerzung_cost_usd numeric(12,6)
);

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
    -- Position/Beleg-Nr., wie sie auf dem Beihilfebescheid selbst steht (von
    -- der KI extrahiert). Nicht zu verwechseln mit subid, der rein internen,
    -- selbst hochgezählten Fortlaufnummer.
    beleg_nr text,
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
    -- Beihilfe-/PKV-Satz zum Zeitpunkt der Periodenanlage. Satzänderungen (z. B. bei
    -- Renteneintritt) beeinflussen abgeschlossene Perioden dadurch nicht rückwirkend.
    satz numeric(5,2),
    -- Restperiode: Nummer der direkten Elternperiode, aus der diese Periode beim
    -- Teilabschluss durch einen Erstattungsbescheid hervorgegangen ist. Bewusst
    -- ohne Fremdschlüssel: das Elternteil steht im selben Tripel, ein
    -- zusammengesetzter FK mit ON DELETE SET NULL würde auch `person` nullen und
    -- damit den Primärschlüssel brechen. Verwaiste Verweise räumen die
    -- Perioden-Operationen selbst ab (service/abrechnungsperiode.js).
    ursprungsperiode integer,
    PRIMARY KEY (person, kostentraeger, periode),
    CONSTRAINT ap_buch_ursprung_ck CHECK (ursprungsperiode IS NULL OR ursprungsperiode <> periode)
);

-- Bestandsdatenbanken nachziehen (die CREATE-TABLE oben ist dort ein No-op).
ALTER TABLE postbuch.abrechnungsperiode_buch
    ADD COLUMN IF NOT EXISTS ursprungsperiode integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ap_buch_ursprung_ck') THEN
    ALTER TABLE postbuch.abrechnungsperiode_buch
      ADD CONSTRAINT ap_buch_ursprung_ck CHECK (ursprungsperiode IS NULL OR ursprungsperiode <> periode);
  END IF;
END $$;

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
    kontoinhaber text,
    bezahlt_am_manuell boolean DEFAULT false NOT NULL,
    bestritten_betrag numeric(12,2),
    CONSTRAINT gen_bestritten_betrag_ck CHECK (bestritten_betrag IS NULL OR (bestritten_betrag > 0 AND bestritten_betrag <= gesamtbetrag))
);

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
    verwendungszweck text,
    bezahlt_am_manuell boolean DEFAULT false NOT NULL,
    bestritten_betrag numeric(12,2),
    CONSTRAINT hand_bestritten_betrag_ck CHECK (bestritten_betrag IS NULL OR (bestritten_betrag > 0 AND bestritten_betrag <= gesamtbetrag))
);

-- Leistungsjahr: eigenes Ganzzahl-Feld für die Jahresgruppierung auf
-- Analyse → Handwerker, getrennt vom freien Text leistungsdatum.
-- CREATE TABLE oben läuft auf Bestandsinstanzen nie erneut — neue Spalte
-- daher per ADD COLUMN IF NOT EXISTS, die Constraint-Definition idempotent
-- über DROP+ADD in einem DO-Block.
ALTER TABLE postbuch.handwerkerrechnung ADD COLUMN IF NOT EXISTS leistungsjahr integer;
DO $$
BEGIN
  ALTER TABLE postbuch.handwerkerrechnung DROP CONSTRAINT IF EXISTS hand_leistungsjahr_ck;
  ALTER TABLE postbuch.handwerkerrechnung ADD CONSTRAINT hand_leistungsjahr_ck
    CHECK (leistungsjahr IS NULL OR leistungsjahr BETWEEN 1900 AND 2100);
END $$;

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
    -- Marker für Wiedervorlage-Push (verhindert Doppelversand am selben Tag).
    push_notified_on date,
    CONSTRAINT wv_ref_xor_ck CHECK ((((postid IS NOT NULL) AND (akteid IS NULL)) OR ((postid IS NULL) AND (akteid IS NOT NULL))))
);

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
CREATE INDEX IF NOT EXISTS idx_abrechnungsperiode_buch_ursprung ON postbuch.abrechnungsperiode_buch USING btree (person, kostentraeger, ursprungsperiode) WHERE (ursprungsperiode IS NOT NULL);
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

CREATE OR REPLACE TRIGGER tg_block_arz_delete_with_eb
    BEFORE DELETE ON postbuch.arztrechnung
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_block_arz_delete_with_eb();

CREATE OR REPLACE TRIGGER tg_block_arz_position_delete_with_eb
    BEFORE DELETE ON postbuch.arztrechnung_einzelposition
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_block_arz_position_delete_with_eb();

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

-- LxD-Achsen. NULL bleibt zulässig: Dokumente aus der Zeit vor der
-- LxD-Klassifikation tragen keine Achsen, und die Pipeline setzt sie erst in
-- Phase 2. Der Fremdschlüssel prüft nur die gesetzten Werte.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'postbuch_lebensbereich_fkey') THEN
    ALTER TABLE ONLY postbuch.postbuch
      ADD CONSTRAINT postbuch_lebensbereich_fkey
      FOREIGN KEY (lebensbereich) REFERENCES postbuch.lebensbereich(code);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'postbuch_dokumentart_fkey') THEN
    ALTER TABLE ONLY postbuch.postbuch
      ADD CONSTRAINT postbuch_dokumentart_fkey
      FOREIGN KEY (dokumentart) REFERENCES postbuch.dokumentart(code);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'postbuch_art_fkey') THEN
    ALTER TABLE ONLY postbuch.postbuch
      ADD CONSTRAINT postbuch_art_fkey
      FOREIGN KEY (art) REFERENCES postbuch.dokumentart(code);
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
    expires_at          timestamptz NOT NULL,
    -- Signatur des gespeicherten Duplikat-Vektors (ab 1.7.0). Eine Suspension, die
    -- einen Modellwechsel überlebt, darf ihren alten Vektor nicht weiterverwenden.
    embedding_signature text,
    storage_id text,
    storage_backend text NOT NULL DEFAULT 'onedrive'
);

CREATE INDEX IF NOT EXISTS pipeline_suspensions_idx_expires
    ON postbuch._pipeline_suspensions (expires_at);

CREATE TABLE IF NOT EXISTS postbuch._failed_documents (
    onedrive_id     text PRIMARY KEY,
    failed_filename text NOT NULL,
    web_url         text,
    reason          text NOT NULL,
    detail          text,
    source_job_id   uuid REFERENCES postbuch._jobs(id) ON DELETE SET NULL,
    failed_at       timestamptz DEFAULT now(),
    betreff         text,
    document_type   text,
    storage_id text,
    storage_backend text NOT NULL DEFAULT 'onedrive'
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
    source_storage_id text,
    replacement_mode text,
    replaced_storage_id text,
    replaced_filename text,
    state             text NOT NULL DEFAULT 'prepared',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pipeline_file_journal_postid_ck CHECK (postid ~ '^P[0-9]{6}$'),
    CONSTRAINT pipeline_file_journal_state_ck CHECK (state IN ('prepared', 'move_intent', 'moved', 'db_complete', 'eb_pending', 'eb_complete')),
    CONSTRAINT pipeline_file_journal_replacement_mode_ck CHECK (replacement_mode IS NULL OR replacement_mode IN ('same_file', 'duplicate'))
);

-- Additiv für Bestandsinstallationen: Recovery muss unterscheiden können, ob
-- die bewegte Datei das weiter gültige Original oder eine Duplikat-Kandidatin ist.
ALTER TABLE postbuch._pipeline_file_journal
  ADD COLUMN IF NOT EXISTS source_storage_id text;
ALTER TABLE postbuch._pipeline_file_journal
  ADD COLUMN IF NOT EXISTS replacement_mode text;
ALTER TABLE postbuch._pipeline_file_journal
  ADD COLUMN IF NOT EXISTS replaced_storage_id text;
ALTER TABLE postbuch._pipeline_file_journal
  ADD COLUMN IF NOT EXISTS replaced_filename text;
ALTER TABLE postbuch._pipeline_file_journal
  DROP CONSTRAINT IF EXISTS pipeline_file_journal_state_ck;
ALTER TABLE postbuch._pipeline_file_journal
  ADD CONSTRAINT pipeline_file_journal_state_ck
  CHECK (state IN ('prepared', 'move_intent', 'moved', 'db_complete', 'eb_pending', 'eb_complete'));
ALTER TABLE postbuch._pipeline_file_journal
  DROP CONSTRAINT IF EXISTS pipeline_file_journal_replacement_mode_ck;
ALTER TABLE postbuch._pipeline_file_journal
  ADD CONSTRAINT pipeline_file_journal_replacement_mode_ck
  CHECK (replacement_mode IS NULL OR replacement_mode IN ('same_file', 'duplicate'));

CREATE INDEX IF NOT EXISTS pipeline_file_journal_postid_idx
    ON postbuch._pipeline_file_journal (postid);

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
CREATE INDEX IF NOT EXISTS postbuch_idx_storage_id
  ON postbuch.postbuch USING btree (storage_id);
-- Der alte PK auf onedrive_id bleibt bis zum Aufräum-Release; die künftige
-- Identität ist (storage_backend, storage_id).
CREATE UNIQUE INDEX IF NOT EXISTS failed_documents_uq_storage
  ON postbuch._failed_documents USING btree (storage_backend, storage_id);

-- Vorbelegung des aktiven Ablage-Backends. Kein Migrationsrest: seed-settings.js
-- verlässt sich darauf, dass dieser Schlüssel beim Start bereits existiert (der
-- Entrypoint fährt das Schema vor dem Seeding) und wertet ihn deshalb bewusst
-- nicht als Frische-Merkmal. Die Ordner-IDs je Backend stehen in
-- _settings.storage_folders und werden erst vom Ordner-Setup geschrieben.
INSERT INTO postbuch._settings (key, value, updated_at)
  VALUES ('storage_backend', '"onedrive"'::jsonb, now())
  ON CONFLICT (key) DO NOTHING;

-- Salden-Quellen (freies SQL, ob an ein Dokument gebunden ["statisch"] oder über
-- eine ganze Dokumentklasse ["dynamisch"] — beide Typen sind reines Freitext-SQL,
-- der Unterschied ist rein deklarativ) sind ein undokumentiertes Experten-Feature
-- und müssen in den Einstellungen bewusst freigeschaltet werden. Altinstanzen,
-- die schon mindestens eine Quelle angelegt haben, bleiben automatisch aktiv,
-- damit bestehende Salden weiter funktionieren; Neuinstallationen starten
-- deaktiviert.
INSERT INTO postbuch._settings (key, value, updated_at)
  SELECT 'salden_quellen_aktiv',
         to_jsonb(EXISTS (SELECT 1 FROM postbuch.saldo_quelle)),
         now()
  ON CONFLICT (key) DO NOTHING;

-- Modellpreise (llm_cost_<model-id>) tragen Cache-Write- und Cache-Read-Preis
-- als eigene Felder. Einträge ohne diese Felder erhalten einmalig die bei
-- Anthropic übliche Staffel (Write 1,25×, Read 0,1× des Input-Preises), damit
-- niemand Bestandspreise nachtragen muss. Maßgeblich ist das Fehlen des
-- Schlüssels: Ein in den Einstellungen geleertes Feld wird als null
-- gespeichert und bleibt leer.
UPDATE postbuch._settings
   SET value = value
         || jsonb_build_object(
              'cache_write_usd_per_1m',
              CASE WHEN jsonb_typeof(value->'input_usd_per_1m') = 'number'
                   THEN to_jsonb(trim_scale(round((value->>'input_usd_per_1m')::numeric * 1.25, 6))) END,
              'cache_read_usd_per_1m',
              CASE WHEN jsonb_typeof(value->'input_usd_per_1m') = 'number'
                   THEN to_jsonb(trim_scale(round((value->>'input_usd_per_1m')::numeric * 0.1, 6))) END),
       updated_at = now()
 WHERE key LIKE 'llm\_cost\_%'
   AND jsonb_typeof(value) = 'object'
   AND NOT (value ? 'cache_write_usd_per_1m')
   AND NOT (value ? 'cache_read_usd_per_1m');

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

-- Vision-Antworten des Büroassistenten (get_document_pdf_vision), je Dokument
-- UND Frage — anders als document_text_cache (ein Volltext pro Dokument) kann
-- ein Dokument beliebig viele unterschiedliche Fragen samt Antwort tragen.
-- Kein TTL: die zugrundeliegende PDF-Datei eines archivierten Dokuments ändert
-- sich in diesem System nie.
CREATE TABLE IF NOT EXISTS postbuch.document_vision_cache (
    id            bigserial PRIMARY KEY,
    postid        varchar(7) NOT NULL,
    question_hash char(64) NOT NULL,
    question      text,
    answer        text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (postid, question_hash)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_vision_cache_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.document_vision_cache
      ADD CONSTRAINT document_vision_cache_postid_fkey FOREIGN KEY (postid)
        REFERENCES postbuch.postbuch(postid) ON DELETE CASCADE;
  END IF;
END $$;

-- Gelernte reasoning_effort-Fähigkeit OpenAI-kompatibler Modelle (GPT-5.x/o-
-- Serie). Deklarative Caps (lib/llm/registry.js) kennen dieses Feld bewusst
-- nicht — eine hartcodierte Modellliste wäre beim nächsten Release veraltet.
-- Stattdessen lernt der Büroassistent reaktiv EINMAL je (Provider, Modell,
-- Kontext) und merkt sich nur den Fähigkeits-ZUSTAND, nie einen fixen Wert:
-- 'full' = akzeptiert freie reasoning_effort-Werte (Policy entscheidet),
-- 'none_only' = verlangt zwingend 'none' (bekannter Function-Tools-Konflikt),
-- 'unsupported' = Parameter wird komplett abgelehnt (Nicht-Reasoning-Modell).
-- context trennt Function-Tool-Aufrufe von reinen Synthese-Aufrufen, weil nur
-- Ersteres den none_only-Konflikt auslösen kann. Kein TTL: einmal gelernt,
-- bleibt es bis zu einem manuellen Reset gültig — ein Neustart soll nicht
-- erneut eine Fehlrunde kosten.
CREATE TABLE IF NOT EXISTS postbuch.llm_reasoning_capability (
    provider_id text NOT NULL,
    model       text NOT NULL,
    context     text NOT NULL,
    state       text NOT NULL,
    learned_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_id, model, context)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llm_reasoning_capability_context_ck') THEN
    ALTER TABLE ONLY postbuch.llm_reasoning_capability
      ADD CONSTRAINT llm_reasoning_capability_context_ck CHECK (context IN ('tools', 'plain'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llm_reasoning_capability_state_ck') THEN
    ALTER TABLE ONLY postbuch.llm_reasoning_capability
      ADD CONSTRAINT llm_reasoning_capability_state_ck CHECK (state IN ('full', 'none_only', 'unsupported'));
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
    active       boolean NOT NULL DEFAULT true,
    -- Prinzipal als Menschen-ID, sofern es einen gibt (der ENV-Sonderuser "admin"
    -- hat keinen). Siehe Kommentar oben: bewusst ohne Fremdschlüssel.
    mensch_id uuid
);
CREATE INDEX IF NOT EXISTS mcp_tokens_username_idx ON postbuch.mcp_tokens (username);
CREATE INDEX IF NOT EXISTS mcp_tokens_mensch_id_idx ON postbuch.mcp_tokens (mensch_id);
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
    -- 'vorbereitet' | 'trockenlauf' | 'laeuft' | 'pausiert' | 'abgeschlossen'
    -- | 'abgeschlossen_mit_resten' | 'abgebrochen' | 'fehler'
    status        text NOT NULL DEFAULT 'trockenlauf',
    stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Quelle aufgeraeumt (Schritt 6) — Zeitpunkt, sonst NULL.
    cleaned_at    timestamptz,
    -- Backend-Wechsel (Schritt 4) — Zeitpunkt, sonst NULL. Doppelte Aufgabe:
    -- Vorbedingung für rolleLaufZurueck() ("noch nicht umgeschaltet") UND
    -- einzige Grundlage, aus der das Frontend den aktuellen
    -- Migrationsassistenten-Schritt ableitet (kein separater Endpunkt nötig).
    switched_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    error_message text
);

-- Nachgezogen, falls die Tabelle bereits ohne diese Spalte existiert.
ALTER TABLE postbuch._storage_migration_runs
  ADD COLUMN IF NOT EXISTS switched_at timestamptz;

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
    -- | 'zurueckgebaut'
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

-- ============================================================================
-- Beihilfe-Kürzungsworkflow: "Gesehen"-Status, Rechnungszuordnung offen,
-- PKV-Prüfvormerkung samt gehärteter Abrechnungssession (Plan siehe
-- internaldocs/FEATURE_KUERZUNGEN_GESEHEN_PKV_PRUEFUNG_PLAN.md).
-- ============================================================================

-- "Gesehen"-Status: instanzweit, nicht pro Nutzer. Rein informativ – hat für
-- sich genommen KEINE Sperrwirkung auf Reprocess/Löschen (bewusste Abweichung
-- von einer früheren Planfassung).
ALTER TABLE postbuch.erstattungsbescheid_kuerzung
    ADD COLUMN IF NOT EXISTS gesehen_am timestamptz,
    ADD COLUMN IF NOT EXISTS gesehen_von text;

CREATE INDEX IF NOT EXISTS erstattungsbescheid_kuerzung_ungesehen_idx
    ON postbuch.erstattungsbescheid_kuerzung (postid)
    WHERE gesehen_am IS NULL;

-- "Zuordnung offen": explizite Bestätigung, dass eine EB-Einzelposition ohne
-- Rechnungsbezug bleibt (Gegenstück zur vorhandenen manuellen Zuordnung über
-- arz_postid). Beides gleichzeitig ist fachlich widersprüchlich.
ALTER TABLE postbuch.erstattungsbescheid_einzelposition
    ADD COLUMN IF NOT EXISTS ohne_rechnungsbezug_bestaetigt_am timestamptz,
    ADD COLUMN IF NOT EXISTS ohne_rechnungsbezug_bestaetigt_von text,
    ADD COLUMN IF NOT EXISTS beleg_nr text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eb_einzelposition_ohne_bezug_xor_ck') THEN
    ALTER TABLE ONLY postbuch.erstattungsbescheid_einzelposition
      ADD CONSTRAINT eb_einzelposition_ohne_bezug_xor_ck
      CHECK (NOT (arz_postid IS NOT NULL AND ohne_rechnungsbezug_bestaetigt_am IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS erstattungsbescheid_einzelposition_offen_idx
    ON postbuch.erstattungsbescheid_einzelposition (postid)
    WHERE arz_postid IS NULL AND ohne_rechnungsbezug_bestaetigt_am IS NULL;

-- PKV-Prüfvormerkung: eine einzelne Beihilfe-Kürzung wird gegen die aktuell
-- offene PKV-Periode der betroffenen Person zur Prüfung nach dem
-- Beihilfeergänzungstarif vorgemerkt. Referenziert den vollen Kürzungs-
-- Schlüssel (kuerzung_id ist zwar global eindeutig, der zusammengesetzte
-- Fremdschlüssel bleibt trotzdem Pflicht, siehe Architektur-Veto im Plan).
CREATE TABLE IF NOT EXISTS postbuch.beihilfe_kuerzung_pkv_pruefung (
    eb_postid character varying(7) NOT NULL,
    eb_subid integer NOT NULL,
    kuerzung_id integer NOT NULL,
    person text NOT NULL,
    kostentraeger text NOT NULL DEFAULT 'PKV',
    periode integer NOT NULL,
    -- Für serverseitiges Undo bei Periodenoperationen (Merge/Delete/Omit) –
    -- bewusst NICHT über den client-vertrauten movedPostIds-Mechanismus.
    vorherige_periode integer,
    status text NOT NULL DEFAULT 'VORGEMERKT',
    vorgemerkt_am timestamptz NOT NULL DEFAULT now(),
    vorgemerkt_von text,
    eingereicht_am timestamptz,
    eingereicht_session_id uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (eb_postid, eb_subid, kuerzung_id),
    CONSTRAINT bkpp_kostentraeger_ck CHECK (kostentraeger = 'PKV'),
    CONSTRAINT bkpp_status_ck CHECK (status IN ('VORGEMERKT', 'EINGEREICHT'))
);

CREATE INDEX IF NOT EXISTS bkpp_person_periode_status_idx
    ON postbuch.beihilfe_kuerzung_pkv_pruefung (person, periode, status);

-- Optionale Freitext-Erläuterung zur Vormerkung, erscheint gebündelt unter
-- der Tabelle im Vorblatt ("zu <Belegnr/Pos.>: <Erläuterung>").
ALTER TABLE postbuch.beihilfe_kuerzung_pkv_pruefung
    ADD COLUMN IF NOT EXISTS erlaeuterung text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bkpp_kuerzung_fkey') THEN
    -- RESTRICT statt CASCADE: eine bereits eingereichte Vormerkung darf nicht
    -- durch ein Löschen/Reprocess der zugrundeliegenden Kürzung mitgerissen
    -- werden. Das eigentliche Löschverbot übernimmt der Trigger weiter unten.
    ALTER TABLE ONLY postbuch.beihilfe_kuerzung_pkv_pruefung
      ADD CONSTRAINT bkpp_kuerzung_fkey FOREIGN KEY (eb_postid, eb_subid, kuerzung_id)
      REFERENCES postbuch.erstattungsbescheid_kuerzung(postid, eb_subid, kuerzung_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bkpp_periode_fkey') THEN
    ALTER TABLE ONLY postbuch.beihilfe_kuerzung_pkv_pruefung
      ADD CONSTRAINT bkpp_periode_fkey FOREIGN KEY (person, kostentraeger, periode)
      REFERENCES postbuch.abrechnungsperiode_buch(person, kostentraeger, periode)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION postbuch.fn_bkpp_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER tg_bkpp_updated_at
    BEFORE UPDATE ON postbuch.beihilfe_kuerzung_pkv_pruefung
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_bkpp_updated_at();

-- Fachliche Voraussetzungen beim Anlegen einer Vormerkung: Quelle ist ein
-- Beihilfebescheid (kein Tier, weder auf Bescheid- noch auf Personenebene),
-- die betroffene Person ist dieselbe wie auf der EB-Einzelposition, die
-- Person hat PKV aktiv, und die Zielperiode ist offen (COLLECTING) – deren
-- Zeile wird dabei gesperrt, damit kein paralleles Einreichen dazwischenfunkt.
CREATE OR REPLACE FUNCTION postbuch.fn_bkpp_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_eb_kostentraeger text;
  v_eb_ist_tier boolean;
  v_ebp_person text;
  v_mensch_pkv boolean;
  v_mensch_ist_tier boolean;
  v_periode_status postbuch.abrechnungsperiode_status;
BEGIN
  IF NEW.kostentraeger <> 'PKV' THEN
    RAISE EXCEPTION 'NICHT_BEIHILFE_KUERZUNG';
  END IF;

  SELECT e.kostentraeger, e.ist_tier, ep.behandelte_person
    INTO v_eb_kostentraeger, v_eb_ist_tier, v_ebp_person
    FROM postbuch.erstattungsbescheid_kuerzung k
    JOIN postbuch.erstattungsbescheid_einzelposition ep
      ON ep.postid = k.postid AND ep.subid = k.eb_subid
    JOIN postbuch.erstattungsbescheid e ON e.postid = k.postid
   WHERE k.postid = NEW.eb_postid AND k.eb_subid = NEW.eb_subid AND k.kuerzung_id = NEW.kuerzung_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PERSON_FEHLT_ODER_UNGUELTIG';
  END IF;

  IF v_eb_kostentraeger IS DISTINCT FROM 'Beihilfe' OR v_eb_ist_tier THEN
    RAISE EXCEPTION 'NICHT_BEIHILFE_KUERZUNG';
  END IF;

  IF v_ebp_person IS NULL OR v_ebp_person <> NEW.person THEN
    RAISE EXCEPTION 'PERSON_FEHLT_ODER_UNGUELTIG';
  END IF;

  SELECT pkv, ist_tier INTO v_mensch_pkv, v_mensch_ist_tier
    FROM postbuch.mensch WHERE kurzname = NEW.person;

  IF NOT FOUND OR v_mensch_ist_tier OR NOT COALESCE(v_mensch_pkv, false) THEN
    RAISE EXCEPTION 'PKV_NICHT_AKTIV';
  END IF;

  SELECT status INTO v_periode_status
    FROM postbuch.abrechnungsperiode_buch
   WHERE person = NEW.person AND kostentraeger = 'PKV' AND periode = NEW.periode
   FOR UPDATE;

  IF NOT FOUND OR v_periode_status <> 'COLLECTING' THEN
    RAISE EXCEPTION 'KEINE_OFFENE_PKV_PERIODE';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER tg_bkpp_validate
    BEFORE INSERT ON postbuch.beihilfe_kuerzung_pkv_pruefung
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_bkpp_validate();

-- Löschschutz: eine bereits eingereichte Vormerkung darf ihre Kürzungszeile
-- nicht mehr verlieren, egal ob direkt gelöscht oder über eine Kaskade vom
-- Elterndokument aus. Eine nur vorgemerkte (noch nicht eingereichte) Zeile
-- bleibt bewusst löschbar – die UI warnt dort nur, sperrt aber nicht hart.
CREATE OR REPLACE FUNCTION postbuch.fn_block_kuerzung_delete_with_pruefung() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
    FROM postbuch.beihilfe_kuerzung_pkv_pruefung
   WHERE eb_postid = OLD.postid AND eb_subid = OLD.eb_subid AND kuerzung_id = OLD.kuerzung_id;

  IF v_status = 'EINGEREICHT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'kuerzung_eingereicht_delete_guard',
      MESSAGE = format(
        'Kürzung %s/%s/%s kann nicht gelöscht werden: bereits bei der PKV eingereicht',
        OLD.postid, OLD.eb_subid, OLD.kuerzung_id
      ),
      HINT = 'Die Prüfvormerkung zuerst zurückziehen.';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE TRIGGER tg_block_kuerzung_delete_with_pruefung
    BEFORE DELETE ON postbuch.erstattungsbescheid_kuerzung
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_block_kuerzung_delete_with_pruefung();

-- Dokument anpinnen: ein beliebiges Dokument (jede Art) wird mit einem
-- Pflichtgrund an eine offene PKV- und/oder Beihilfe-Periode einer Person
-- angehängt und ganz hinten in deren Einreichungspaket mit ausgeliefert.
-- Kein eigenes Validierungs-Trigger-Geflecht wie bei der Kürzungsvormerkung:
-- der Service prüft vor dem INSERT dieselbe offene COLLECTING-Periode, und
-- die FKs erledigen den Rest. postid RESTRICT ist bewusst unbedingt (nicht
-- nur bei EINGEREICHT) — ein angepinntes Dokument muss erst entpinnt werden,
-- bevor es gelöscht werden kann.
CREATE TABLE IF NOT EXISTS postbuch.dokument_pin (
    id integer NOT NULL GENERATED ALWAYS AS IDENTITY,
    postid character varying(7) NOT NULL,
    person text NOT NULL,
    kostentraeger text NOT NULL,
    periode integer NOT NULL,
    grund text NOT NULL,
    status text NOT NULL DEFAULT 'VORGEMERKT',
    vorgemerkt_am timestamptz NOT NULL DEFAULT now(),
    vorgemerkt_von text,
    eingereicht_am timestamptz,
    eingereicht_session_id uuid,
    PRIMARY KEY (id),
    UNIQUE (postid, person, kostentraeger),
    CONSTRAINT dokument_pin_grund_ck CHECK (btrim(grund) <> ''),
    CONSTRAINT dokument_pin_kostentraeger_ck CHECK (kostentraeger IN ('PKV', 'Beihilfe')),
    CONSTRAINT dokument_pin_status_ck CHECK (status IN ('VORGEMERKT', 'EINGEREICHT'))
);

CREATE INDEX IF NOT EXISTS dokument_pin_person_periode_status_idx
    ON postbuch.dokument_pin (person, kostentraeger, periode, status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dokument_pin_postid_fkey') THEN
    ALTER TABLE ONLY postbuch.dokument_pin
      ADD CONSTRAINT dokument_pin_postid_fkey FOREIGN KEY (postid) REFERENCES postbuch.postbuch(postid) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dokument_pin_periode_fkey') THEN
    ALTER TABLE ONLY postbuch.dokument_pin
      ADD CONSTRAINT dokument_pin_periode_fkey FOREIGN KEY (person, kostentraeger, periode)
      REFERENCES postbuch.abrechnungsperiode_buch(person, kostentraeger, periode)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- Gehärtete Abrechnungssession: exakte Ziel-Sperrung, Artefakte in
-- _abrechnung_sessions.artefakte (JSONB, siehe dort). Der Blockinhalt von
-- PKV-Prüfvormerkungen/Anpinnungen wird weiterhin live gelesen (siehe
-- abrechnung-paket.js) – zusätzlich werden ihre Schlüssel beim Bau in
-- _abrechnung_session_ziel.snapshot_pruefung_keys/snapshot_pin_postids
-- festgehalten (ebenso die regulären Rechnungen in snapshot_postids, schon
-- beim Öffnen der Session). confirmAbrechnungsperiode() nutzt das, um Zeilen,
-- die erst NACH dem PDF-Bau dazugekommen sind, nicht lautlos mit einzureichen,
-- sondern in die neu angelegte Folgeperiode zu verschieben.
-- _abrechnung_sessions.status bekommt bewusst KEIN CHECK (Projektkonvention
-- für Job-/Session-Statusspalten – ein CHECK in einem idempotenten Vollschema
-- erzwingt DROP+ADD gegen die Live-DB, sobald ein Statuswert dazukommt; siehe
-- z. B. den bereits produktiven, dokumentenlosen Status 'timed_out').
ALTER TABLE postbuch._abrechnung_sessions
    ALTER COLUMN groups SET DEFAULT '[]'::jsonb;

ALTER TABLE postbuch._abrechnung_sessions
    ADD COLUMN IF NOT EXISTS artefakte jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Ein Zieltripel (Person/Kostenträger/Periode) darf höchstens eine aktive
-- Session haben – verhindert parallele Abrechnungsläufe auf demselben Ziel.
CREATE TABLE IF NOT EXISTS postbuch._abrechnung_session_ziel (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id uuid NOT NULL,
    person text NOT NULL,
    kostentraeger text NOT NULL,
    periode integer NOT NULL,
    aktiv boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS abrechnung_session_ziel_session_idx
    ON postbuch._abrechnung_session_ziel (session_id);

CREATE UNIQUE INDEX IF NOT EXISTS abrechnung_session_ziel_aktiv_uq
    ON postbuch._abrechnung_session_ziel (person, kostentraeger, periode)
    WHERE aktiv;

-- Snapshot dessen, was tatsächlich ins PDF gewandert ist (siehe Kommentar
-- oberhalb der Tabelle) – für den Nachlaufschutz in confirmAbrechnungsperiode().
ALTER TABLE postbuch._abrechnung_session_ziel
    ADD COLUMN IF NOT EXISTS snapshot_postids text[] NOT NULL DEFAULT '{}';
ALTER TABLE postbuch._abrechnung_session_ziel
    ADD COLUMN IF NOT EXISTS snapshot_pruefung_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE postbuch._abrechnung_session_ziel
    ADD COLUMN IF NOT EXISTS snapshot_pin_postids text[] NOT NULL DEFAULT '{}';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bkpp_session_fkey') THEN
    ALTER TABLE ONLY postbuch.beihilfe_kuerzung_pkv_pruefung
      ADD CONSTRAINT bkpp_session_fkey FOREIGN KEY (eingereicht_session_id)
      REFERENCES postbuch._abrechnung_sessions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abrechnung_session_ziel_session_fkey') THEN
    ALTER TABLE ONLY postbuch._abrechnung_session_ziel
      ADD CONSTRAINT abrechnung_session_ziel_session_fkey FOREIGN KEY (session_id)
      REFERENCES postbuch._abrechnung_sessions(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abrechnung_session_ziel_periode_fkey') THEN
    ALTER TABLE ONLY postbuch._abrechnung_session_ziel
      ADD CONSTRAINT abrechnung_session_ziel_periode_fkey FOREIGN KEY (person, kostentraeger, periode)
      REFERENCES postbuch.abrechnungsperiode_buch(person, kostentraeger, periode)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- Konkurrenzschutz: solange eine aktive Abrechnungssession (Status 'building'
-- oder 'pending') ein Zieltripel referenziert, dürfen die davon eingesammelten
-- Vormerkungen und die zugrundeliegenden Kürzungen nicht mehr verändert werden
-- – sonst würde der bereits erzeugte Prüfblock/Vorblatt von den Live-Daten
-- abweichen. Zentralisiert als Trigger (Projektkonvention, siehe
-- fn_block_kuerzung_delete_with_pruefung) statt in jeder einzelnen Route
-- dupliziert. Der Zustand 'confirming' ist bewusst NICHT gesperrt: er lebt nur
-- innerhalb der einen, kurzen confirmAbrechnungsperiode-Transaktion, die selbst
-- exakt diese Zeilen von VORGEMERKT auf EINGEREICHT umschreibt.
CREATE OR REPLACE FUNCTION postbuch.fn_block_bkpp_write_during_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_row postbuch.beihilfe_kuerzung_pkv_pruefung;
BEGIN
  v_row := COALESCE(OLD, NEW);
  IF EXISTS (
    SELECT 1 FROM postbuch._abrechnung_session_ziel z
    JOIN postbuch._abrechnung_sessions s ON s.id = z.session_id
    WHERE z.aktiv AND s.status IN ('building', 'pending')
      AND z.person = v_row.person AND z.kostentraeger = v_row.kostentraeger AND z.periode = v_row.periode
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55006',
      MESSAGE = format(
        'Vormerkung %s/%s/%s kann nicht geändert werden: aktive Abrechnungssession für diese Periode',
        v_row.eb_postid, v_row.eb_subid, v_row.kuerzung_id
      ),
      HINT = 'Die Abrechnungssession zuerst abschließen oder abbrechen.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE TRIGGER tg_block_bkpp_write_during_session
    BEFORE UPDATE OR DELETE ON postbuch.beihilfe_kuerzung_pkv_pruefung
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_block_bkpp_write_during_session();

CREATE OR REPLACE FUNCTION postbuch.fn_block_kuerzung_write_during_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_row postbuch.erstattungsbescheid_kuerzung;
BEGIN
  v_row := COALESCE(OLD, NEW);
  IF EXISTS (
    SELECT 1 FROM postbuch.beihilfe_kuerzung_pkv_pruefung b
    JOIN postbuch._abrechnung_session_ziel z
      ON z.person = b.person AND z.kostentraeger = b.kostentraeger AND z.periode = b.periode AND z.aktiv
    JOIN postbuch._abrechnung_sessions s ON s.id = z.session_id AND s.status IN ('building', 'pending')
    WHERE b.eb_postid = v_row.postid AND b.eb_subid = v_row.eb_subid AND b.kuerzung_id = v_row.kuerzung_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55006',
      MESSAGE = format(
        'Kürzung %s/%s/%s kann nicht geändert werden: für eine vorgemerkte Prüfung läuft bereits eine Abrechnungssession',
        v_row.postid, v_row.eb_subid, v_row.kuerzung_id
      ),
      HINT = 'Die Abrechnungssession zuerst abschließen oder abbrechen.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE TRIGGER tg_block_kuerzung_write_during_session
    BEFORE UPDATE OR DELETE ON postbuch.erstattungsbescheid_kuerzung
    FOR EACH ROW EXECUTE FUNCTION postbuch.fn_block_kuerzung_write_during_session();

-- ============================================================================
-- Kostenträger-Profile (Plan siehe internaldocs/FEATURE_KOSTENTRAEGER_PROFILE.md)
-- Beschreiben rein deskriptiv bekannte Absender-Layouts für den generischen
-- EB-Parse-Prompt. Ein Profil erweitert/übersteuert nie das Zielmodell.
-- ============================================================================

CREATE TABLE IF NOT EXISTS postbuch.kostentraeger_profil (
    id                 SERIAL PRIMARY KEY,
    name               TEXT NOT NULL,
    kostentraeger      TEXT NOT NULL,
    profiltext         TEXT NOT NULL,
    aktiv              BOOLEAN NOT NULL DEFAULT FALSE,
    quelle             TEXT NOT NULL DEFAULT 'generiert',
    erzeugt_von_modell TEXT,
    erzeugt_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    aktualisiert_am    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT kostentraeger_profil_kostentraeger_ck
        CHECK (kostentraeger IN ('PKV', 'Beihilfe')),
    CONSTRAINT kostentraeger_profil_quelle_ck
        CHECK (quelle IN ('generiert', 'importiert', 'mitgeliefert')),
    CONSTRAINT kostentraeger_profil_name_length_ck
        CHECK (char_length(name) <= 200),
    CONSTRAINT kostentraeger_profil_profiltext_length_ck
        CHECK (char_length(profiltext) <= 4000)
);

CREATE INDEX IF NOT EXISTS kostentraeger_profil_aktiv_idx
    ON postbuch.kostentraeger_profil (aktiv) WHERE aktiv = true;

-- Mitgelieferte Profile leben als statischer Katalog im Code
-- (lib/kostentraeger-profil-katalog.js), nicht als Seed-Zeilen: Anders als
-- Schema-DDL lässt sich ein einmaliger Daten-Seed nie per Baseline-Schnitt auf
-- den Ist-Zustand zusammenfassen (die Zeile könnte inzwischen verändert/
-- gelöscht worden sein) — jedes künftig mitgelieferte Profil hätte sonst einen
-- für immer bleibenden eigenen Migrationsblock gebraucht. Eine Zeile hier
-- entsteht für ein mitgeliefertes Profil deshalb erst, wenn der Admin es aus
-- dem Katalog aktiviert ("materialisiert"); katalog_schluessel/katalog_version
-- verankern, von welchem Katalogeintrag welcher Version sie abstammt, damit
-- eine spätere Textänderung im Code als "Update verfügbar" erkennbar ist statt
-- die Zeile stillschweigend zu überschreiben.
ALTER TABLE postbuch.kostentraeger_profil
    ADD COLUMN IF NOT EXISTS katalog_schluessel TEXT,
    ADD COLUMN IF NOT EXISTS katalog_version INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS kostentraeger_profil_katalog_schluessel_uq
    ON postbuch.kostentraeger_profil (katalog_schluessel) WHERE katalog_schluessel IS NOT NULL;

-- Zusätzliche additive Spalten am Bescheid: welches Profil hat gepasst (falls
-- eines aktiv war). Der Name wird redundant mitgeführt, damit ein späteres
-- Löschen oder Umbenennen des Profils die historische Nachvollziehbarkeit
-- am einzelnen Bescheid nicht kappt.
ALTER TABLE postbuch.erstattungsbescheid
    ADD COLUMN IF NOT EXISTS kostentraeger_profil_id INTEGER,
    ADD COLUMN IF NOT EXISTS kostentraeger_profil_name TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erstattungsbescheid_kostentraeger_profil_id_fkey') THEN
    ALTER TABLE ONLY postbuch.erstattungsbescheid
      ADD CONSTRAINT erstattungsbescheid_kostentraeger_profil_id_fkey
      FOREIGN KEY (kostentraeger_profil_id)
      REFERENCES postbuch.kostentraeger_profil(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================================
-- Rechnungsteile und QR-Codes
-- (Plan siehe internaldocs/FEATURE_RECHNUNGSTEILE_UND_QRCODES.md)
-- ============================================================================

-- Schritt I — QR-Codes: lokal ausgelesene QR-Codes eines Dokuments (GiroCode,
-- Patientenportal-Link, …). NULL = nie gescannt, [] = gescannt, nichts
-- gefunden. Keine eigene Tabelle: die Liste wird nur am Dokument angezeigt,
-- nie gejoint, nie gesucht, und umfasst ein bis drei Einträge.
ALTER TABLE postbuch.postbuch ADD COLUMN IF NOT EXISTS qr_codes jsonb;

-- Schritt II — Einreichungsseiten: Spalten einreichung_seite_von/_bis stehen
-- bei CREATE TABLE postbuch.arztrechnung weiter oben (fachlich dort zuhause,
-- da nur Arztrechnungen zusammengestellt und eingereicht werden).
