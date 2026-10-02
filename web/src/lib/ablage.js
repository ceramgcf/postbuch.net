/**
 * Anzeigenamen der Dateiablage-Backends – eine Quelle für alle Karten im Dateiablage-Tab.
 *
 * „nextcloud" ist der technische Adaptername (ownCloud-WebDAV-Familie); im UI
 * heißt das Ding bewusst „WebDAV-Speicher", weil Nextcloud, ownCloud und
 * MagentaCLOUD gleichermaßen darunter fallen.
 */
export const ABLAGE_LABEL = { onedrive: 'OneDrive', nextcloud: 'WebDAV-Speicher' };

export const ablageLabel = (backend) => ABLAGE_LABEL[backend] || backend;
