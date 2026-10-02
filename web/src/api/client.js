const BASE = '/api';

async function request(path, options = {}) {
  const { noRedirect, ...fetchOptions } = options;
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...fetchOptions.headers },
    ...fetchOptions,
    // API-Antworten und insbesondere Redirects dürfen Updates/Rollbacks nie
    // im persistenten HTTP-Cache des Browserprofils überleben.
    cache: 'no-store',
  });
  if (!res.ok) {
    // Only redirect if not already on login-related path and noRedirect not set
    if (res.status === 401 && !noRedirect && !path.startsWith('/auth/')) {
      window.location.href = '/login';
    }
    const text = await res.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* keine JSON-Antwort */ }

    // Status und geparster Body am Error: der Login braucht `verbleibendeVersuche`
    // bzw. `retryAfterSec` aus der Antwort, nicht nur den Meldungstext.
    const err = new Error(payload?.error || text || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return res.json();
}

export const api = {
  postbuch: {
    list: (params) => {
      const cleaned = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      return request(`/postbuch?${new URLSearchParams(cleaned)}`);
    },
    get: (postid) => request(`/postbuch/${postid}`),
    update: (postid, data) => request(`/postbuch/${postid}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    delete: (postid) => request(`/actions/delete/${postid}`, { method: 'POST' }),
    updateStatus: (postid, status) => request(`/postbuch/${postid}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
    markPaid: (postid, date) => request(`/postbuch/${postid}/bezahlt`, {
      method: 'POST',
      body: JSON.stringify({ bezahlt_am: date }),
    }),
    setBestritten: (postid, bestritten_betrag) => request(`/postbuch/${postid}/bestritten`, {
      method: 'PUT',
      body: JSON.stringify({ bestritten_betrag }),
    }),
    setAP: (postid, kostentraeger, periode) => request(`/postbuch/${postid}/arztrechnung/abrechnungsperiode`, {
      method: 'PATCH',
      body: JSON.stringify({ kostentraeger, periode }),
    }),
    setSatz: (postid, data) => request(`/postbuch/${postid}/arztrechnung/satz`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    updateHandwerker: (postid, data) => request(`/postbuch/${postid}/handwerkerrechnung`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    updateArztrechnung: (postid, data) => request(`/postbuch/${postid}/arztrechnung`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    /**
     * EBP (Erstattungsbescheid-Position) einer ganzen Arztrechnung zuordnen/lösen. arzPostid=null löst.
     * restoreKuerzungenArzSubid: optionale [{kuerzung_id, arz_subid}]-Liste für den Undo-Pfad – stellt die
     * Positionsbezüge der Kind-Kürzungen gezielt wieder her, statt sie pauschal zu nullen.
     */
    setErstattungZuordnung: (postid, subid, arzPostid, restoreKuerzungenArzSubid) => request(`/postbuch/${postid}/erstattung/${subid}/zuordnung`, {
      method: 'PATCH',
      body: JSON.stringify({ arz_postid: arzPostid, restore_kuerzungen_arz_subid: restoreKuerzungenArzSubid ?? undefined }),
    }),
    /** Neue Kürzung unter einer EBP anlegen. data: { kuerzungsbetrag, begruendung?, arz_subid? } */
    addKuerzung: (postid, subid, data) => request(`/postbuch/${postid}/erstattung/${subid}/kuerzung`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    /** Kürzung ändern. data: { kuerzungsbetrag?, begruendung?, arz_subid? } */
    updateKuerzung: (postid, kuerzungId, data) => request(`/postbuch/${postid}/kuerzung/${kuerzungId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    /** Kürzung löschen (z. B. fälschlich erkannt). */
    deleteKuerzung: (postid, kuerzungId) => request(`/postbuch/${postid}/kuerzung/${kuerzungId}`, {
      method: 'DELETE',
    }),
    /** Kürzung instanzweit als gesehen markieren/zurücknehmen. */
    setKuerzungGesehen: (postid, kuerzungId, ebSubid, gesehen) => request(`/postbuch/${postid}/kuerzung/${kuerzungId}/gesehen`, {
      method: 'PATCH',
      body: JSON.stringify({ gesehen, eb_subid: ebSubid }),
    }),
    /** Kürzung für die aktuell offene PKV-Periode der Person zur Prüfung vormerken, optional mit Erläuterung. */
    vormerkenPkvPruefung: (postid, kuerzungId, ebSubid, erlaeuterung) => request(`/postbuch/${postid}/kuerzung/${kuerzungId}/pkv-pruefung`, {
      method: 'PUT',
      body: JSON.stringify({ eb_subid: ebSubid, erlaeuterung: erlaeuterung || null }),
    }),
    /** PKV-Prüfvormerkung zurückziehen (nur solange nicht eingereicht). */
    entfernePkvPruefung: (postid, kuerzungId, ebSubid) => request(`/postbuch/${postid}/kuerzung/${kuerzungId}/pkv-pruefung?eb_subid=${encodeURIComponent(ebSubid)}`, {
      method: 'DELETE',
    }),
    /** Erläuterung einer Vormerkung setzen/ändern/entfernen (erlaeuterung: null zum Entfernen). */
    setPkvPruefungErlaeuterung: (postid, kuerzungId, ebSubid, erlaeuterung) => request(`/postbuch/${postid}/kuerzung/${kuerzungId}/pkv-pruefung/erlaeuterung`, {
      method: 'PATCH',
      body: JSON.stringify({ eb_subid: ebSubid, erlaeuterung: erlaeuterung || null }),
    }),
    /** Bestätigt/widerruft "keine Rechnungszuordnung erforderlich" für eine EBP. */
    setOhneRechnungsbezug: (postid, subid, bestaetigt) => request(`/postbuch/${postid}/erstattung/${subid}/ohne-rechnungsbezug`, {
      method: 'PATCH',
      body: JSON.stringify({ bestaetigt }),
    }),
    updateGenRechnung: (postid, data) => request(`/postbuch/${postid}/generischerechnung`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    deleteGenRechnung: (postid) => request(`/postbuch/${postid}/generischerechnung`, {
      method: 'DELETE',
    }),
    /** Ersetzt das PDF eines bestehenden Eintrags (ohne KI-Pipeline). */
    replacePdf: (postid, payload) => request(`/postbuch/${postid}/replace-pdf`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    /** Tauscht zwei OneDrive-Dateien zurück. Symmetrisch, also auch für Redo. */
    restoreReplacedPdf: (postid, payload) => request(`/postbuch/${postid}/replace-pdf/restore`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    embeddingQueue: () => request('/postbuch/embedding-queue', { noRedirect: true }),
    missingEmbeddings: () => request('/postbuch/missing-embeddings', { noRedirect: true }),
    /** Anpinnungen eines Dokuments an PKV-/Beihilfe-Perioden. */
    listePins: (postid) => request(`/postbuch/${postid}/pins`),
    /** Dokument an die aktuelle Periode einer Person/eines Kostenträgers anpinnen (grund ist Pflicht). */
    pinDokument: (postid, person, kostentraeger, grund) => request(`/postbuch/${postid}/pins`, {
      method: 'POST',
      body: JSON.stringify({ person, kostentraeger, grund }),
    }),
    /** Noch nicht eingereichte Anpinnung lösen. */
    unpinDokument: (postid, person, kostentraeger) => request(`/postbuch/${postid}/pins/${encodeURIComponent(person)}/${encodeURIComponent(kostentraeger)}`, {
      method: 'DELETE',
    }),
    /** QR-Codes eines Bestandsdokuments nachrüsten (kein Massen-Backfill). */
    qrScan: (postid) => request(`/postbuch/${postid}/qr-scan`, {
      method: 'POST',
    }),
  },
  search: {
    fulltext: (q, opts = {}) => {
      const params = new URLSearchParams({ q });
      if (opts.historisch) params.set('historisch', opts.historisch);
      return request(`/search?${params}`);
    },
    semantic: (q, opts = {}) => {
      const params = new URLSearchParams({ q });
      if (opts.historisch) params.set('historisch', opts.historisch);
      if (opts.offset) params.set('offset', String(opts.offset));
      return request(`/search/semantic?${params}`);
    },
    aktenFulltext: (q, opts = {}) => {
      const params = new URLSearchParams({ q });
      if (opts.historisch) params.set('historisch', opts.historisch);
      return request(`/search/akten?${params}`);
    },
    aktenSemantic: (q, opts = {}) => {
      const params = new URLSearchParams({ q });
      if (opts.historisch) params.set('historisch', opts.historisch);
      if (opts.offset) params.set('offset', String(opts.offset));
      return request(`/search/akten/semantic?${params}`);
    },
    /** Leichtgewichtiges Autocomplete für #P/#A-Referenzen (Nummer oder Betreff/Kontakt).
     *  opts.arten (Array oder CSV) schränkt auf Dokument-Arten ein (dann keine Akten). */
    suggest: (q, limit = 8, opts = {}) => {
      const params = new URLSearchParams({ q, limit: String(limit) });
      if (opts.arten) params.set('arten', Array.isArray(opts.arten) ? opts.arten.join(',') : opts.arten);
      return request(`/search/suggest?${params}`);
    },
  },
  files: {
    pdfUrl: (postid) => `${BASE}/files/${postid}/pdf`,
    suspendedPdfUrl: (fileId) => `${BASE}/files/suspended/${fileId}/pdf`,
    fetchFromArchive: async (postid) => {
      const res = await fetch(`${BASE}/files/${postid}/pdf/fetch`, { credentials: 'include' });
      if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('Nicht authentifiziert');
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json();
    },
    rotatePdf: (postid, winkel) => request(`/files/${postid}/pdf/rotate`, {
      method: 'POST',
      body: JSON.stringify({ winkel }),
    }),
    fetchProgress: (postid) => request(`/files/${postid}/pdf/fetch-progress`),
  },
  actions: {
    reprocess: (postid, instructions, textebeneEntfernen = false, modelTier = 'auto') => request(`/actions/reprocess/${postid}`, {
      method: 'POST',
      body: JSON.stringify({ instructions, textebeneEntfernen, modelTier }),
    }),
    textebeneStatus: (postid) => request(`/actions/textebene-status/${postid}`),
    reprocessStatus: (postid) => request(`/actions/reprocess-status/${postid}`),
    changeType: (postid, newL, newD, confirmReprocess = false) =>
      request(`/actions/change-type/${postid}`, {
        method: 'POST',
        body: JSON.stringify({ newL, newD, confirmReprocess }),
      }),
    /** Rechnungsblock entfernen, weil eine Korrekturrechnung sie ersetzt hat.
     *  Ohne confirm liefert der Server nur die Ankündigung (requires_confirm). */
    rechnungInvalidieren: (postid, confirm = false) =>
      request(`/actions/rechnung-invalidieren/${postid}`, {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      }),
    retryMissingEmbeddings: () => request('/actions/retry-missing-embeddings', { method: 'POST' }),
  },
  taxonomie: { get: () => request('/taxonomie') },
  jobs: {
    list: () => request('/jobs'),
    get: (id) => request(`/jobs/${id}`),
    cancel: (id) => request(`/jobs/${id}/cancel`, { method: 'POST' }),
  },
  import: {
    scannerPort: () => request('/public/scanner-port'),
    scan: (body) => request('/import/scan', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    /** Scan auslösen, dessen Ergebnis das PDF eines bestehenden Eintrags ersetzt. */
    scanReplace: (postid, body) => request('/import/scan-replace', {
      method: 'POST',
      body: JSON.stringify({ postid, ...body }),
    }),
    upload: (filename, dataB64, hinweis, batchSize) => request('/import/upload', {
      method: 'POST',
      body: JSON.stringify({ filename, dataB64, ...(hinweis ? { hinweis } : {}), ...(batchSize > 1 ? { batchSize } : {}) }),
    }),
    uploadMerged: (filename, files, hinweis) => request('/import/upload-merged', {
      method: 'POST',
      body: JSON.stringify({ filename, files, ...(hinweis ? { hinweis } : {}) }),
    }),
    /**
     * Lädt ein Dokumentenübergabe-ZIP zur Vorprüfung hoch. Der Job liefert die
     * im Paket vorkommenden Personen samt Zuordnungsvorschlag; importiert wird
     * erst mit `archivStart`.
     * Rohes Streaming statt Base64/JSON (bis zu 2 GB) — braucht darum ein
     * eigenes XHR statt des JSON-Helpers `request()`, u. a. für Upload-Fortschritt.
     * @param {File|Blob} file Die ZIP-Datei
     * @param {(anteil: number) => void} [onProgress] Fortschritt 0..1
     * @returns {Promise<{jobId: string, token: string}>}
     */
    archivVorpruefung: (file, onProgress) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/import/archiv/vorpruefung`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => {
        let payload = null;
        try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* keine JSON-Antwort */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
        } else {
          if (xhr.status === 401) window.location.href = '/login';
          const err = new Error(payload?.error || `HTTP ${xhr.status}`);
          err.status = xhr.status;
          err.payload = payload;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error('Netzwerkfehler beim Hochladen'));
      xhr.send(file);
    }),
    /**
     * @param {string} token aus `archivVorpruefung`
     * @param {{conflictMode: 'skip'|'createNew', personenZuordnung: Record<string, string|null>}} body
     * @returns {Promise<{jobId: string}>}
     */
    archivStart: (token, body) => request(`/import/archiv/${encodeURIComponent(token)}/start`, {
      method: 'POST', body: JSON.stringify(body),
    }),
    archivVerwerfen: (token) => request(`/import/archiv/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  },
  analyse: {
    unbezahlt: () => request('/analyse/unbezahlt'),
    /** @param {'offen'|'alle'|'gesehen'} [gesehen] Default serverseitig 'offen'. */
    kuerzungen: (gesehen) => request(`/analyse/kuerzungen${gesehen ? `?gesehen=${gesehen}` : ''}`),
    perioden: () => request('/analyse/perioden'),
    periodenRechnungen: (person, kostentraeger, periode) =>
      request(`/analyse/perioden/${encodeURIComponent(person)}/${encodeURIComponent(kostentraeger)}/${encodeURIComponent(periode)}/rechnungen`),
    handwerker: () => request('/analyse/handwerker'),
    collectingPerioden: () => request('/analyse/perioden/collecting'),
  },
  stats: {
    dashboard: () => request('/stats/dashboard'),
    scanRetryQueue: () => request('/stats/scan-retry-queue'),
  },
  akten: {
    list: (params) => {
      const cleaned = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      return request(`/akten?${new URLSearchParams(cleaned)}`);
    },
    get: (akteid) => request(`/akten/${akteid}`),
    create: (data) => request('/akten', { method: 'POST', body: JSON.stringify(data) }),
    update: (akteid, data) => request(`/akten/${akteid}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    delete: (akteid) => request(`/akten/${akteid}`, { method: 'DELETE' }),
    snapshot: (akteid) => request(`/akten/${akteid}/snapshot`),
    restore: (data) => request('/akten/restore', { method: 'POST', body: JSON.stringify(data) }),
    addDocument: (akteid, postid) => request(`/akten/${akteid}/dokumente`, {
      method: 'POST',
      body: JSON.stringify({ postid }),
    }),
    removeDocument: (akteid, postid) => request(`/akten/${akteid}/dokumente/${postid}`, {
      method: 'DELETE',
    }),
    reorderDocuments: (akteid, order) => request(`/akten/${akteid}/dokumente/order`, {
      method: 'PUT',
      body: JSON.stringify({ order }),
    }),
    byPostId: (postid) => request(`/akten/by-postid/${postid}`),
    recent: () => request('/akten/recent'),
    aiVorschlag: (akteid) => request(`/akten/${akteid}/ki-vorschlag`, { method: 'POST' }),
    embeddingQueue: () => request('/akten/embedding-queue', { noRedirect: true }),
    semanticForDoc: (postid) => request(`/akten/semantic-for-doc/${postid}`),
    setHistorisch: (akteid, historisch, auch_dokumente) => request(`/akten/${akteid}/historisch`, {
      method: 'PATCH',
      body: JSON.stringify({ historisch, auch_dokumente }),
    }),
    historischCheck: (akteid, historisch) => request(`/akten/${akteid}/historisch-check?historisch=${historisch}`),
  },
  auth: {
    login: (username, password) => request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
    changePassword: (payload) => request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    check: () => request('/auth/check'),
  },
  logs: {
    list: (params) => {
      const cleaned = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      return request(`/logs?${new URLSearchParams(cleaned)}`);
    },
    system: (params) => {
      const cleaned = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      return request(`/logs/system?${new URLSearchParams(cleaned)}`);
    },
    llm: (params) => {
      const cleaned = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      return request(`/logs/llm?${new URLSearchParams(cleaned)}`);
    },
    llmStats: () => request('/logs/llm/stats'),
  },
  salden: {
    list: () => request('/salden'),
    get: (id) => request(`/salden/${id}`),
    create: (data) => request('/salden', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/salden/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => request(`/salden/${id}`, { method: 'DELETE' }),
    addBuchung: (saldoId, data) => request(`/salden/${saldoId}/buchungen`, {
      method: 'POST', body: JSON.stringify(data),
    }),
    editBuchung: (saldoId, buchungId, data) => request(`/salden/${saldoId}/buchungen/${buchungId}`, {
      method: 'PATCH', body: JSON.stringify(data),
    }),
    deleteBuchung: (saldoId, buchungId) => request(`/salden/${saldoId}/buchungen/${buchungId}`, {
      method: 'DELETE',
    }),
    addQuelle: (saldoId, data) => request(`/salden/${saldoId}/quellen`, {
      method: 'POST', body: JSON.stringify(data),
    }),
    editQuelle: (saldoId, quelleId, data) => request(`/salden/${saldoId}/quellen/${quelleId}`, {
      method: 'PATCH', body: JSON.stringify(data),
    }),
    deleteQuelle: (saldoId, quelleId) => request(`/salden/${saldoId}/quellen/${quelleId}`, {
      method: 'DELETE',
    }),
    testSQL: (sql) => request('/salden/test-sql', {
      method: 'POST', body: JSON.stringify({ sql }),
    }),
  },
  // Fachliche Person und App-Zugang werden gemeinsam als „Mensch" verwaltet.
  menschen: {
    list: () => request('/menschen'),
    create: (data) => request('/menschen', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/menschen/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => request(`/menschen/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    loeschVorschau: (id) => request(`/menschen/${encodeURIComponent(id)}/loesch-vorschau`),
    loeschen: (id, data) => request(`/menschen/${encodeURIComponent(id)}/loeschen`, { method: 'POST', body: JSON.stringify(data) }),
  },
  dev: {
    status: () => request('/dev/status'),
    unlock: (key) => request('/dev/unlock', { method: 'POST', body: JSON.stringify({ key }) }),
  },
  kostentraegerProfile: {
    list: () => request('/kostentraeger-profile'),
    katalog: () => request('/kostentraeger-profile/katalog'),
    katalogAktivieren: (schluessel) => request(`/kostentraeger-profile/katalog/${encodeURIComponent(schluessel)}/aktivieren`, { method: 'POST' }),
    updateAnwenden: (id) => request(`/kostentraeger-profile/${id}/update-anwenden`, { method: 'POST' }),
    aktivieren: (id) => request(`/kostentraeger-profile/${id}/aktivieren`, { method: 'POST' }),
    deaktivieren: (id) => request(`/kostentraeger-profile/${id}/deaktivieren`, { method: 'POST' }),
    delete: (id) => request(`/kostentraeger-profile/${id}`, { method: 'DELETE' }),
    kandidatenAkten: () => request('/kostentraeger-profile/kandidaten-akten'),
    profilieren: (akteid) => request('/kostentraeger-profile/profilieren', {
      method: 'POST',
      body: JSON.stringify({ akteid }),
    }),
    import: (daten) => request('/kostentraeger-profile/import', {
      method: 'POST',
      body: JSON.stringify(daten),
    }),
  },
  wiedervorlagen: {
    list: (params) => {
      const cleaned = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      return request(`/wiedervorlagen?${new URLSearchParams(cleaned)}`);
    },
    dashboard: () => request('/wiedervorlagen/dashboard'),
    kalender: (von, bis) => request(`/wiedervorlagen/kalender?von=${von}&bis=${bis}`),
    create: (data) => request('/wiedervorlagen', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/wiedervorlagen/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => request(`/wiedervorlagen/${id}`, { method: 'DELETE' }),
  },
  // Admin-only (Backend: /api/settings hängt hinter requireAdmin).
  // Alles, was auch Nicht-Admins brauchen, steht unter api.settingsPublic.
  // In-GUI-Updates (admin-only). Die App führt hier nichts aus – sie schreibt
  // eine Anforderung, die ein Agent auf dem Host abholt. Ohne Agenten gibt es
  // keinen Installieren-Button, sondern einen Kopierbefehl.
  updates: {
    get:       () => request('/updates'),
    pruefen:   () => request('/updates/pruefen',   { method: 'POST' }),
    starten:   () => request('/updates/starten',   { method: 'POST' }),
    abbrechen: () => request('/updates/abbrechen', { method: 'POST' }),
    kanal:     (vorabversionen) => request('/updates/kanal', {
      method: 'PUT', body: JSON.stringify({ vorabversionen }),
    }),
    hostconfig: (typ, wert, secret) => request('/updates/hostconfig', {
      method: 'POST', body: JSON.stringify({ typ, wert, ...(secret ? { secret } : {}) }),
    }),
    // text/plain, nicht JSON – deshalb an `request` vorbei.
    log: async () => {
      const res = await fetch(`${BASE}/updates/log`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
  },

  einrichtung: {
    status: () => request('/einrichtung'),
    pruefen: (storageSelbsttest = false) => request('/einrichtung/pruefen', {
      method: 'POST', body: JSON.stringify({ storageSelbsttest }),
    }),
    storageSelbsttestStart: () => request('/einrichtung/storage-selbsttest/start', { method: 'POST' }),
    duckdnsPruefen: (domain) => request('/einrichtung/duckdns-pruefen', { method: 'POST', body: JSON.stringify({ domain }) }),
    einladung: () => request('/einrichtung/einladung', { method: 'POST' }),
    schritt: (id, abgeschlossen = true) => request(`/einrichtung/schritte/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify({ abgeschlossen }),
    }),
    abschliessen: () => request('/einrichtung/abschliessen', { method: 'POST' }),
    ueberspringen: () => request('/einrichtung/ueberspringen', { method: 'POST' }),
    trotzdemAnsehen: () => request('/einrichtung/trotzdem-ansehen', { method: 'POST' }),
    oeffnen: () => request('/einrichtung/oeffnen', { method: 'POST' }),
  },

  scannerTuning: {
    status: () => request('/scanner-tuning'),
    scan: (slot, options) => request(`/scanner-tuning/pages/${slot}/scan`, {
      method: 'POST', body: JSON.stringify(options),
    }),
    remove: (slot) => request(`/scanner-tuning/pages/${slot}`, { method: 'DELETE' }),
    removeAll: () => request('/scanner-tuning/pages', { method: 'DELETE' }),
    analyze: (parameters) => request('/scanner-tuning/analyze', {
      method: 'POST', body: JSON.stringify({ parameters }),
    }),
    render: () => request('/scanner-tuning/render', { method: 'POST' }),
    apply: (parameters) => request('/scanner-tuning/apply', {
      method: 'POST', body: JSON.stringify({ parameters }),
    }),
    previewUrl: (slot, version) => `${BASE}/scanner-tuning/previews/${slot}?v=${encodeURIComponent(version || Date.now())}`,
    rawPreviewUrl: (slot, version) => `${BASE}/scanner-tuning/raw-previews/${slot}?v=${encodeURIComponent(version || Date.now())}`,
  },

  settings: {
    getAll: () => request('/settings'),
    update: (key, value) => request(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
    promptsPreview: () => request('/settings/prompts-preview'),
    /** Ablagestruktur ('lxd' | 'person_lxd'). Umschalten startet den Gesamtumzug. */
    ablageStruktur: () => request('/settings/ablage-struktur'),
    setAblageStruktur: (struktur) => request('/settings/ablage-struktur', {
      method: 'POST', body: JSON.stringify({ struktur }),
    }),
    /**
     * Fragt das Scanner-Gerät nach seinen Fähigkeiten und speichert das
     * Ergebnis. `scanner_capabilities` steht bewusst nicht in
     * ALLOWED_SETTING_KEYS – geschrieben wird ausschließlich hierüber.
     */
    scannerCapabilities: (deviceUrl) => request('/settings/scanner/capabilities', {
      method: 'POST', body: JSON.stringify(deviceUrl ? { deviceUrl } : {}),
    }),
    scannerDiscover: (ip, maske, port = 'alle', protokoll = 'alle') => request('/settings/scanner/discover', {
      method: 'POST', body: JSON.stringify({ ip, maske, port, protokoll }),
    }),
    scannerNetzvorschlag: () => request('/settings/scanner/netzvorschlag'),
    ai: {
      // fresh=true umgeht den 60-s-Cache im Backend – nur für den
      // ausdrücklichen „Status neu prüfen"-Klick, nie beim Polling.
      health: (fresh = false) => request(`/settings/ai/health${fresh ? '?fresh=1' : ''}`),
      setKey: (provider, key, region) => request('/settings/ai/key', {
        method: 'PUT',
        body: JSON.stringify({ provider, key, ...(region ? { region } : {}) }),
      }),
      listModels: (provider, fresh = false) =>
        request(`/settings/ai/models/${encodeURIComponent(provider)}${fresh ? '?fresh=1' : ''}`),
      subscriptionTest: () => request('/settings/ai/subscription/test', { method: 'POST' }),

      // Provider-Registry (Phase 1, UI in Phase 5). Geschrieben wird
      // AUSSCHLIESSLICH über diese Routen – `llm_providers` steht bewusst nicht
      // in ALLOWED_SETTING_KEYS, weil der generische PUT die URL-Validierung
      // und die Typ-Sperre für Built-ins überspringen würde.
      providers: {
        list:   () => request('/settings/ai/providers'),
        save:   (id, payload) => request(`/settings/ai/providers/${encodeURIComponent(id)}`, {
          method: 'PUT', body: JSON.stringify(payload),
        }),
        // force erst nach ausdrücklicher zweiter Bestätigung – der erste
        // Versuch soll die 409-Liste `benutztVon` zurückgeben.
        remove: (id, force = false) => request(
          `/settings/ai/providers/${encodeURIComponent(id)}${force ? '?force=1' : ''}`,
          { method: 'DELETE' },
        ),
        setKey: (id, key) => request(`/settings/ai/providers/${encodeURIComponent(id)}/key`, {
          method: 'PUT', body: JSON.stringify({ key }),
        }),
        test:   (id) => request(`/settings/ai/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }),
      },

      // Embedding-Slot. Die Dimension wird serverseitig geprobt, nie vom
      // Client übernommen – eine erfundene `dim` vergiftet still jede Suche.
      embedding: {
        get: () => request('/settings/ai/embedding'),
        set: (providerId, model) => request('/settings/ai/embedding', {
          method: 'PUT', body: JSON.stringify({ providerId, model }),
        }),
        // alle=false (Default) rechnet nur Zeilen mit abweichender Signatur neu.
        rebuild: (alle = false) => request('/actions/rebuild-embeddings', {
          method: 'POST', body: JSON.stringify({ alle }),
        }),
      },

      // Releasegebundene Modellempfehlungen. Die Online-Methoden bleiben als
      // deaktivierter Rueckweg erhalten; GET und Anwenden arbeiten lokal.
      empfehlungen: {
        get:            () => request('/settings/ai/empfehlungen'),
        abonnieren:     () => request('/settings/ai/empfehlungen/abonnieren', { method: 'POST' }),
        automatik:      () => request('/settings/ai/empfehlungen/automatik', { method: 'POST' }),
        pruefen:        () => request('/settings/ai/empfehlungen/pruefen', { method: 'POST' }),
        // klassen: Array von Klassen-Keys oder der String 'alle'
        anwenden:       (klassen) => request('/settings/ai/empfehlungen/anwenden', {
          method: 'POST', body: JSON.stringify({ klassen }),
        }),
        zuruecksetzen:  () => request('/settings/ai/empfehlungen/zuruecksetzen', { method: 'POST' }),
      },
    },
    // „Verlässt hier gerade etwas das Haus?" – admin-only, nur Booleans und
    // Anzeigenamen, keine Hosts (app/src/lib/cloudfrei.js).
    cloudfreiCheck: () => request('/settings/cloudfree-check'),
    notifications: {
      discord: {
        get: () => request('/settings/notifications/discord'),
        set: (webhookUrl, risikoBestaetigt = false) => request('/settings/notifications/discord', {
          method: 'PUT',
          body: JSON.stringify({ webhookUrl, risikoBestaetigt }),
        }),
        setBot: ({ botToken, channelId, risikoBestaetigt = false }) => request('/settings/notifications/discord/bot', {
          method: 'PUT',
          body: JSON.stringify({ botToken, channelId, risikoBestaetigt }),
        }),
        test: () => request('/settings/notifications/discord/test', { method: 'POST' }),
      },
      // Instanzweiter Push-Schalter + wer gerade tatsächlich Push bekommt.
      webpush: {
        get: () => request('/settings/notifications/webpush'),
        set: (erlaubt) => request('/settings/notifications/webpush', {
          method: 'PUT',
          body: JSON.stringify({ erlaubt }),
        }),
      },
    },
  },
  // Für ALLE eingeloggten Rollen (Backend: /api/settings-public, Feld-Whitelist).
  // getAll() liefert bewusst nur instance_name, nav_visibility und die drei
  // scanner_*-Flags – mehr braucht kein Nicht-Admin-Bildschirm.
  settingsPublic: {
    getAll: () => request('/settings-public'),
    einrichtungGate: () => request('/settings-public/einrichtung-gate'),
    getDebugMode: () => request('/settings-public/debug-mode'),
    setDebugMode: (enabled) => request('/settings-public/debug-mode', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
    backupStatus: () => request('/settings-public/backup-status'),
    // Aufgelöste Pfade/Intervalle für die Seite „Dokumente importieren".
    importwege: () => request('/settings-public/importwege'),
    ai: {
      health: () => request('/settings-public/ai/health'),
      tierModels: () => request('/settings-public/ai/tier-models'),
      cacheMode: {
        get: () => request('/settings-public/ai/cache-mode'),
        set: ({ active, tier }) => request('/settings-public/ai/cache-mode', {
          method: 'PUT',
          body: JSON.stringify({ active, tier }),
        }),
      },
    },
  },
  mcpTokens: {
    list: () => request('/mcp-tokens'),
    create: ({ description, expiresAt } = {}) => request('/mcp-tokens', {
      method: 'POST',
      body: JSON.stringify({ description, expiresAt }),
    }),
    revoke: (id) => request(`/mcp-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  backup: {
    listFiles: () => request('/backup/files'),
    // Selbst ausgelöste Sicherung: startet und liefert sofort den Lauf-Zustand,
    // Fortschritt danach über manuellStatus().
    manuellStarten: () => request('/backup/manuell', { method: 'POST' }),
    manuellStatus: () => request('/backup/manuell'),
    runNow: () => request('/jobs/backup/run', { method: 'POST' }),
    // vorabSicherungId = ID der durchgelaufenen Zwangssicherung; ohne sie
    // verlangt der Server ohneVorabSicherung nach ausdrücklicher Warnung.
    // noRedirect: ein 401 hier kann ein falsches BACKUP-Passwort sein, keine
    // abgelaufene Session — sonst reißt request() die Seite auf /login um,
    // bevor die Mutation den Fehler inline anzeigen kann.
    restore: (fileId, { vorabSicherungId, ohneVorabSicherung, backupPasswort } = {}) => request('/backup/restore', {
      method: 'POST',
      body: JSON.stringify({ fileId, vorabSicherungId, ohneVorabSicherung, backupPasswort }),
      noRedirect: true,
    }),
    restoreUpload: (file, { vorabSicherungId, ohneVorabSicherung, backupPasswort } = {}) => request('/backup/restore-upload', {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
        ...(vorabSicherungId ? { 'X-Vorab-Sicherung': vorabSicherungId } : {}),
        ...(ohneVorabSicherung ? { 'X-Ohne-Vorab-Sicherung': '1' } : {}),
        ...(backupPasswort ? { 'X-Backup-Passwort': encodeURIComponent(backupPasswort) } : {}),
      },
      noRedirect: true,
    }),
    getSettings: () => request('/backup/settings'),
    updateSettings: (data) => request('/backup/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
    // Verschlüsselung: aktivieren/Passwort ändern
    // ({enabled:true, passwort, passwortWiederholung, neuesPasswort?}) oder
    // bewusst ablehnen/deaktivieren ({enabled:false, bewusst:true}).
    updateEncryption: (data) => request('/backup/encryption', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
    // noRedirect: ein falsch eingegebenes Adminpasswort beim Step-up ist kein
    // Session-Ablauf, sondern eine normale Fehleingabe — inline anzeigen.
    revealEncryptionPasswort: (appPasswort) => request('/backup/encryption/reveal', {
      method: 'POST',
      body: JSON.stringify({ appPasswort }),
      noRedirect: true,
    }),
  },
  onedrive: {
    status: () => request('/onedrive-auth/status'),
    authorize: (returnTo) => request('/onedrive-auth/authorize', {
      method: 'POST',
      body: JSON.stringify(returnTo ? { returnTo } : {}),
    }),
    disconnect: () => request('/onedrive-auth/disconnect', { method: 'POST' }),
    // Device-Code-Flow (eigene Public-Client-App)
    deviceStart: () => request('/onedrive-auth/device/start', { method: 'POST' }),
    deviceStatus: (flowId) => request(`/onedrive-auth/device/status/${encodeURIComponent(flowId)}`),
    deviceCancel: (flowId) => request(`/onedrive-auth/device/${encodeURIComponent(flowId)}`, { method: 'DELETE' }),
    setAuthMode: (mode) => request('/settings/onedrive/auth-mode', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),
    getCredentials: () => request('/settings/onedrive/credentials'),
    saveCredentials: (payload) => request('/settings/onedrive/credentials', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
    // Der aktuell eingerichtete Wurzelordner – Vorbelegung des Setup-Assistenten
    // (und der Migrations-Karte, dort mit dem ZIEL-Backend als Parameter).
    // rootPath === null: noch nichts eingerichtet.
    folderRoot: (backend) => request(`/settings/onedrive-folders/root${backend ? `?backend=${encodeURIComponent(backend)}` : ''}`),
    // `bestaetigt` nur setzen, nachdem der Nutzer die Warnung vor einem
    // abweichenden Wurzelordner ausdrücklich weggeklickt hat (HTTP 409).
    setupWizard: (rootPath, bestaetigt = false, async = false) => request('/settings/onedrive-folders/setup-wizard', {
      method: 'POST',
      body: JSON.stringify({ rootPath, bestaetigt, async }),
    }),
    resolveId: (id) => request(`/settings/onedrive-folders/item-path?id=${encodeURIComponent(id)}`),
    // Prüft für alle Dokumente mit Dateiablage-ID, ob die Datei dort noch existiert
    // (nur bestätigte 404s lösen die Verknüpfung, siehe storage-missing.js).
    scanMissing: () => request('/settings/onedrive-folders/scan-missing', { method: 'POST' }),
  },

  // Dateiablage: Nextcloud-Verbindung (Phase 3). Der Ordner-/DR-Teil oben ist
  // bereits backend-agnostisch und wird geteilt.
  nextcloud: {
    status:      () => request('/settings/nextcloud/status'),
    saveConfig:  (payload) => request('/settings/nextcloud/config', { method: 'PUT', body: JSON.stringify(payload) }),
    saveCredentials: (payload) => request('/settings/nextcloud/credentials', { method: 'PUT', body: JSON.stringify(payload) }),
    test:        () => request('/settings/nextcloud/test', { method: 'POST' }),
    disconnect:  () => request('/settings/nextcloud/disconnect', { method: 'POST' }),
    flowStart:   () => request('/settings/nextcloud/login-flow/start', { method: 'POST' }),
    flowStatus:  () => request('/settings/nextcloud/login-flow/status'),
    flowCancel:  () => request('/settings/nextcloud/login-flow/cancel', { method: 'POST' }),
  },

  storage: {
    selectInitialBackend: (backend) => request('/settings/storage/initial-backend', {
      method: 'PUT', body: JSON.stringify({ backend }),
    }),
    // Nimmt die Erstwahl zurück, solange die Instanz sie nachweislich noch
    // nicht benutzt hat (keine Verbindung, keine Ordner, keine Dokumente).
    // Danach antwortet der Server mit 409 – dann ist es ein Umzug.
    resetInitialBackend: () => request('/settings/storage/initial-backend', { method: 'DELETE' }),
    // Backend-agnostischer Zustand der aktiven Dateiablage (Dashboard-Banner).
    status: () => request('/settings/storage/status'),
    selftest: (backend) => request(`/settings/storage/${encodeURIComponent(backend)}/selftest`, { method: 'POST' }),
    freeSpace: (backend) => request(`/settings/storage/${encodeURIComponent(backend)}/free-space`),
  },

  // Dateiablage-Migration (Phase 4). Alle Endpunkte liegen unter /settings und sind
  // damit admin-only.
  migration: {
    aktuell:      () => request('/settings/storage/migration/aktuell'),
    zielVorbereiten: (backend, rootPath) => request('/settings/storage/migration/ziel-vorbereiten',
                     { method: 'POST', body: JSON.stringify({ backend, rootPath }) }),
    trockenlauf:  (src, dst) => request('/settings/storage/migration/trockenlauf',
                     { method: 'POST', body: JSON.stringify({ src, dst }) }),
    get:          (runId) => request(`/settings/storage/migration/${runId}`),
    restliste:    (runId) => request(`/settings/storage/migration/${runId}/restliste`),
    start:        (runId) => request(`/settings/storage/migration/${runId}/start`, { method: 'POST' }),
    abbrechen:    (runId) => request(`/settings/storage/migration/${runId}/abbrechen`, { method: 'POST' }),
    abbrechenVollstaendig: (runId) => request(`/settings/storage/migration/${runId}/abbrechen-vollstaendig`, { method: 'POST' }),
    abschliessen: (runId) => request(`/settings/storage/migration/${runId}/abschliessen`, { method: 'POST' }),
    restErneut:   (runId, postid) => request(`/settings/storage/migration/${runId}/rest/${postid}/erneut`, { method: 'POST' }),
    restOhneDatei:(runId, postid) => request(`/settings/storage/migration/${runId}/rest/${postid}/ohne-datei`, { method: 'POST' }),
    restLoeschen: (runId, postid) => request(`/settings/storage/migration/${runId}/rest/${postid}/loeschen`,
                     { method: 'POST', body: JSON.stringify({ confirm: true }) }),
    rueckbauVorschau: (runId) => request(`/settings/storage/migration/${runId}/rueckbau`),
    rueckbau:     (runId, erwarteteAnzahl) => request(`/settings/storage/migration/${runId}/rueckbau`,
                     { method: 'POST', body: JSON.stringify({ confirm: true, erwarteteAnzahl }) }),
    aufraeumenVorschau: (runId) => request(`/settings/storage/migration/${runId}/aufraeumen`),
    aufraeumen:   (runId, erwarteteAnzahl) => request(`/settings/storage/migration/${runId}/aufraeumen`,
                     { method: 'POST', body: JSON.stringify({ confirm: true, erwarteteAnzahl }) }),
    abschliessenOhneAufraeumen: (runId) => request(`/settings/storage/migration/${runId}/abschliessen-ohne-aufraeumen`,
                     { method: 'POST' }),
    umschalten:   (ziel) => request('/settings/storage/migration/umschalten',
                     { method: 'POST', body: JSON.stringify({ ziel, confirm: true }) }),
    nachzueglerPruefen:   (runId) => request(`/settings/storage/migration/${runId}/nachzuegler`),
    nachzueglerAufnehmen: (runId) => request(`/settings/storage/migration/${runId}/nachzuegler`, { method: 'POST' }),
  },
  dr: {
    status:           () => request('/dr/status'),
    fingerprintRun:   () => request('/dr/fingerprint-run', { method: 'POST' }),
    resolveRoot:      (input) => request('/dr/recovery/resolve', { method: 'POST', body: JSON.stringify({ input }) }),
    startRecovery:    (rootFolderId, rootLabel) => request('/dr/recovery/start', { method: 'POST', body: JSON.stringify({ rootFolderId, rootLabel }) }),
    getSession:       (sid) => request(`/dr/recovery/${sid}`),
    manualLink:       (sid, postid, fileId) => request(`/dr/recovery/${sid}/manual/link`,   { method: 'POST', body: JSON.stringify({ postid, fileId }) }),
    manualLeave:      (sid, postid)         => request(`/dr/recovery/${sid}/manual/leave`,  { method: 'POST', body: JSON.stringify({ postid }) }),
    manualDelete:     (sid, postid)         => request(`/dr/recovery/${sid}/manual/delete`, { method: 'POST', body: JSON.stringify({ postid, confirm: true }) }),
    extrasSearch:     (sid, q) => request(`/dr/recovery/${sid}/extras-search?q=${encodeURIComponent(q || '')}`),
  },
  // Nur lesend – verwaltet wird über `menschen`.
  personen: {
    list: () => request('/personen'),
  },
  abrechnungsperiode: {
    // POST /start → gibt sofort { jobId } zurück; Fortschritt per SSE unter progressUrl()
    start: (payload) => request('/abrechnungsperiode/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    progressUrl: (jobId) => `/api/abrechnungsperiode/progress/${jobId}`,
    sessions: () => request('/abrechnungsperiode/sessions'),
    session: (id) => request(`/abrechnungsperiode/sessions/${id}`),
    // Gibt eine direkte URL zurück (für iframe/Download – kein fetch, nutzt Browser-Session-Cookie)
    pdfUrl: (id, groupIndex) => `/api/abrechnungsperiode/sessions/${id}/pdf/${groupIndex}`,
    chunkUrl: (id, groupIndex, chunkIndex) => `/api/abrechnungsperiode/sessions/${id}/pdf/${groupIndex}/chunk/${chunkIndex}`,
    confirm: (id) => request(`/abrechnungsperiode/sessions/${id}/confirm`, { method: 'POST' }),
    reject: (id) => request(`/abrechnungsperiode/sessions/${id}/reject`, { method: 'POST' }),
    setStatus: (person, kostentraeger, periode, targetStatus, expectedCurrentStatus) =>
      request('/abrechnungsperiode/periode/status', {
        method: 'POST',
        body: JSON.stringify({ person, kostentraeger, periode, targetStatus, expectedCurrentStatus }),
      }),
    omit: (person, kostentraeger, periode) =>
      request('/abrechnungsperiode/periode/omit', {
        method: 'POST',
        body: JSON.stringify({ person, kostentraeger, periode }),
      }),
    undoOmit: (person, kostentraeger, periode, autoCreatedPeriode) =>
      request('/abrechnungsperiode/periode/undo-omit', {
        method: 'POST',
        body: JSON.stringify({ person, kostentraeger, periode, autoCreatedPeriode }),
      }),
    deleteHighest: (person, kostentraeger, periode) =>
      request('/abrechnungsperiode/periode/delete-highest', {
        method: 'POST',
        body: JSON.stringify({ person, kostentraeger, periode }),
      }),
    merge: (person, kostentraeger, sourcePeriode, targetPeriode) =>
      request('/abrechnungsperiode/periode/merge', {
        method: 'POST',
        body: JSON.stringify({ person, kostentraeger, sourcePeriode, targetPeriode }),
      }),
    nullAP: (person, kostentraeger, periode) =>
      request('/abrechnungsperiode/periode/null-ap', {
        method: 'POST',
        body: JSON.stringify({ person, kostentraeger, periode }),
      }),
    restore: (person, kostentraeger, periode, postIds, status, movedKuerzungen) =>
      request('/abrechnungsperiode/periode/restore', {
        method: 'POST',
        body: JSON.stringify({ person, kostentraeger, periode, postIds, status, movedKuerzungen }),
      }),
  },
  export: {
    /**
     * Löst einen binären Download aus.
     * @param {object} opts
     * @param {'pdf-merged'|'zip'|'excel'|'zip-archiv'} opts.format
     * @param {string[]} opts.postids
     * @param {string} [opts.akteid]
     */
    download: async ({ format, postids, akteid }) => {
      const res = await fetch(`${BASE}/export`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, postids, akteid }),
      });
      if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('Nicht authentifiziert');
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      // Dateiname aus Content-Disposition-Header
      const cd = res.headers.get('Content-Disposition') || '';
      const match = cd.match(/filename="([^"]+)"/);
      a.download = match?.[1] || 'export';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    /**
     * Startet einen asynchronen Export-Job (Fortschritt via SSE) und liefert { jobId }.
     * Formate mit Job-Flow: 'zip', 'pdf-merged', 'zip-archiv'.
     */
    startJob: ({ format, postids, akteid }) => request('/export', {
      method: 'POST',
      body: JSON.stringify({ format, postids, akteid, useJobFlow: true }),
    }),
    /** Lädt das Ergebnis eines fertigen Export-Jobs herunter (löst Browser-Download aus). */
    downloadJob: (jobId) => {
      window.location.href = `${BASE}/export/download/${jobId}`;
    },
    /**
     * Fetches all postids matching the given filters (no pagination limit).
     * Uses the existing postbuch list endpoint in pages of 200.
     */
    fetchAllPostIds: async (filters) => {
      const PAGE_SIZE = 200;
      let offset = 0;
      const allIds = [];
      while (true) {
        const cleaned = Object.fromEntries(
          Object.entries({ ...filters, limit: PAGE_SIZE, offset }).filter(([, v]) => v != null && v !== '')
        );
        const result = await request(`/postbuch?${new URLSearchParams(cleaned)}`);
        allIds.push(...result.data.map(d => d.postid));
        if (allIds.length >= result.total || result.data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      return allIds;
    },
  },
  pendingDecisions: {
    list: () => request('/postbuch/pending-decisions'),
    get: (jobId, token) => {
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      return request(`/postbuch/pending-decisions/${jobId}${qs}`, { noRedirect: !!token });
    },
    decide: (jobId, decision, token) => request(`/actions/duplicate-decision/${jobId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, token }),
      noRedirect: !!token,
    }),
  },
  failedDocuments: {
    list: () => request('/postbuch/failed'),
    reprocess: (onedriveId) => request(`/actions/reprocess-failed/${encodeURIComponent(onedriveId)}`, {
      method: 'POST',
    }),
    delete: (onedriveId) => request(`/postbuch/failed/${encodeURIComponent(onedriveId)}`, {
      method: 'DELETE',
    }),
  },
  verbleib: {
    list: () => request('/verbleib'),
    listAll: () => request('/verbleib/all'),
    create: (data) => request('/verbleib', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/verbleib/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    archive: (id) => request(`/verbleib/${id}`, { method: 'DELETE' }),
    ablagen: {
      list: (params) => {
        const qs = params ? '?' + new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
        ).toString() : '';
        return request(`/verbleib/ablagen${qs}`);
      },
      create: (data) => request('/verbleib/ablagen', { method: 'POST', body: JSON.stringify(data) }),
      update: (id, data) => request(`/verbleib/ablagen/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      archive: (id) => request(`/verbleib/ablagen/${id}/archive`, { method: 'PATCH' }),
      delete: (id) => request(`/verbleib/ablagen/${id}`, { method: 'DELETE' }),
      aufloesen: (id, data) => request(`/verbleib/ablagen/${id}/aufloesen`, { method: 'POST', body: JSON.stringify(data) }),
      loeseKategorieAuf: (data) => request('/verbleib/ablagen/loese-kategorie-auf', { method: 'POST', body: JSON.stringify(data) }),
    },
  },
  chat: {
    listConversations: () => request('/chat/conversations'),
    createConversation: (title) => request('/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
    getConversation: (id) => request(`/chat/conversations/${id}`),
    deleteConversation: (id) => request(`/chat/conversations/${id}`, { method: 'DELETE' }),
    renameConversation: (id, title) => request(`/chat/conversations/${id}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
    /** Führt die zur Bestätigung vorgemerkten (destruktiven) Aktionen einer Nachricht aus. */
    confirmActions: (messageId) => request(`/chat/messages/${messageId}/confirm`, { method: 'POST' }),
    /** Verwirft die vorgemerkten Aktionen einer Nachricht (ohne Ausführung). */
    discardActions: (messageId) => request(`/chat/messages/${messageId}/discard`, { method: 'POST' }),
    /** Macht die ausgeführten Akten-Änderungen einer Nachricht rückgängig. */
    undoActions: (messageId) => request(`/chat/messages/${messageId}/undo`, { method: 'POST' }),
    /** Sendet eine Nachricht und gibt einen EventSource zurück (SSE-Stream). */
    sendMessage: (conversationId, message) => {
      // SSE benötigt einen POST-Body – wir nutzen fetch + ReadableStream
      return { conversationId, message };
    },
    /** Gibt die SSE-URL für das Senden einer Nachricht zurück – nicht direkt verwendbar,
     *  da POST-Body gesendet werden muss. Nutze sendMessageStream() stattdessen. */
    sendMessageStream: async (conversationId, message, onProgress, onToken, onSources, onDone, onError, opts = {}) => {
      // opts.onActions: (data) => void – Assistenten-Aktionen (Akten-Änderungen)
      // opts.signal: AbortSignal (Stop-Button) – Abbruch schließt die Verbindung,
      // der Server bricht den Agent-Lauf daraufhin sofort ab. opts.onAborted wird
      // statt onError gerufen, wenn der Nutzer selbst abgebrochen hat.
      try {
        const res = await fetch(`${BASE}/chat/conversations/${conversationId}/messages`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, writeEnabled: opts.writeEnabled === true }),
          signal: opts.signal,
        });
        if (res.status === 401) { window.location.href = '/login'; return; }
        if (!res.ok) { const t = await res.text(); onError?.(t || `HTTP ${res.status}`); return; }

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';

          let currentEvent = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
            if (!line.startsWith('data: '))  continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === 'progress') onProgress?.(data.label);
              else if (currentEvent === 'token')   onToken?.(data.text);
              else if (currentEvent === 'thinking') opts.onThinking?.(data.text);
              else if (currentEvent === 'sources') onSources?.(data.sources);
              else if (currentEvent === 'actions') opts.onActions?.(data);
              else if (currentEvent === 'done')    onDone?.(data);
              else if (currentEvent === 'error')   onError?.(data.message);
            } catch { /* ungültige SSE-Zeile */ }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') { opts.onAborted?.(); return; }
        onError?.(err.message || 'Verbindungsfehler');
      }
    },
  },
};
