# Zugriff von unterwegs

postbuch.net läuft in deinem Heimnetz. Von unterwegs erreichst du es am
sichersten über ein **VPN**: Das Smartphone baut eine verschlüsselte Verbindung
nach Hause auf und verhält sich danach so, als stünde es im eigenen WLAN. Die
Instanz selbst bleibt dabei für das Internet unsichtbar, es wird kein Port für
postbuch.net am Router geöffnet.

Davon abzuraten ist, die Oberfläche per Portfreigabe direkt ins Internet zu
stellen. postbuch.net hat keine Zwei-Faktor-Anmeldung und ist nicht für den
offenen Betrieb gehärtet (siehe [Sicherheit](sicherheit.md#grenzen--was-postbuchnet-nicht-leistet)).
Ein VPN nimmt dieses Risiko heraus, ohne dass du auf etwas verzichten musst.

Zwei Wege bieten sich an:

| Weg | Passt, wenn … | Aufwand |
|---|---|---|
| [WireGuard über die FRITZ!Box](#weg-1-wireguard-über-die-fritzbox) | du eine FRITZ!Box mit aktuellem FRITZ!OS hast und dein Anschluss von außen erreichbar ist | gering, alles im Router |
| [Tailscale](#weg-2-tailscale) | dein Anschluss von außen nicht erreichbar ist (z. B. viele Kabel- und Glasfaseranschlüsse mit DS-Lite) oder du keine FRITZ!Box hast | gering, aber ein zusätzlicher Dienst mit eigenem Konto |

Andere Router mit eingebautem VPN-Server (WireGuard oder OpenVPN) funktionieren
nach demselben Prinzip; die Menüs heißen dort anders.

## Vorab: Funktioniert es zu Hause?

Prüfe zuerst im Heimnetz, unter welcher Adresse du postbuch.net aufrufst:

- **Mit DuckDNS-Domain** (z. B. `https://meinpostbuch.duckdns.org`): Diese
  Adresse funktioniert über das VPN genauso, inklusive installierter App und
  Push-Nachrichten. Das ist der empfohlene Fall. Die DuckDNS-Domain zeigt auf
  die Adresse des Servers im Heimnetz; genau deshalb ist sie nur von dort aus
  erreichbar, und das VPN bringt dich dorthin.
- **Ohne Domain** (z. B. `http://192.168.178.20:3420`): Auch diese Adresse geht
  über das VPN, im Browser. Eine installierte App und Push-Nachrichten
  brauchen aber eine HTTPS-Adresse (siehe [Mobil und PWA](mobil-und-pwa.md#als-app-installieren-pwa)).

Hat die Domain zu Hause einen DNS-Rebind-Schutz gebraucht (siehe
[FAQ](faq.md#betrieb)), gilt dieselbe Ausnahme auch für das VPN, solange das
Smartphone den Router als DNS-Server nutzt. Bei der FRITZ!Box trägt die
WireGuard-Einrichtung das selbst ein.

## Weg 1: WireGuard über die FRITZ!Box

Voraussetzung ist eine FRITZ!Box mit FRITZ!OS 7.50 oder neuer.

1. `http://fritz.box` öffnen und anmelden.
2. **Internet → Freigaben → VPN (WireGuard)** → **Verbindung hinzufügen**.
3. **Einzelgerät verbinden** wählen, **Weiter**, einen Namen vergeben (z. B.
   „Handy Anna“) und die Einrichtung abschließen. Die FRITZ!Box zeigt danach
   einen QR-Code.
4. Auf dem Smartphone die App **WireGuard** aus dem Play Store bzw. App Store
   installieren, dort **+** → **QR-Code scannen** und den Code abfotografieren.
5. Verbindung in der WireGuard-App einschalten und postbuch.net unter der
   gewohnten Adresse öffnen.

Kann die FRITZ!Box keine Verbindung von außen annehmen, meldet sie das bei der
Einrichtung oder die Verbindung kommt unterwegs nicht zustande. Häufigster
Grund ist ein Anschluss ohne eigene öffentliche IPv4-Adresse (DS-Lite).
Manche Anbieter schalten auf Anfrage eine öffentliche IPv4-Adresse frei;
sonst ist [Tailscale](#weg-2-tailscale) der einfachere Weg.

## Weg 2: Tailscale

[Tailscale](https://tailscale.com) baut ebenfalls WireGuard-Verbindungen auf,
braucht aber keine Portfreigabe und funktioniert auch hinter DS-Lite. Dafür
legst du ein eigenes, für den Privatgebrauch kostenloses Konto bei Tailscale
an. Tailscale vermittelt den Verbindungsaufbau zwischen deinen Geräten; die
Daten selbst laufen Ende-zu-Ende-verschlüsselt direkt zwischen ihnen. Prüfe
selbst, ob dir dieser zusätzliche Anbieter recht ist.

Auf dem Server, auf dem postbuch.net läuft:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
sudo tailscale up --advertise-routes=192.168.178.0/24
```

`192.168.178.0/24` ist das Heimnetz einer FRITZ!Box im Auslieferungszustand.
Liegt dein Server in einem anderen Netz, etwa `192.168.1.x`, lautet der Wert
`192.168.1.0/24`. Der letzte Befehl zeigt einen Anmeldelink; darüber meldest
du den Server an deinem Tailscale-Konto an.

Danach in der Tailscale-Verwaltung unter **Machines** beim Server die
angebotene Route unter **Subnets** freigeben. Auf dem Smartphone die
Tailscale-App installieren und mit demselben Konto anmelden. Android und iOS
übernehmen freigegebene Routen von selbst; postbuch.net ist dann unter der
gewohnten Adresse erreichbar.

## Im Alltag

- **Push-Nachrichten kommen auch ohne VPN an.** Sie laufen über den
  Benachrichtigungsdienst des Browsers. Erst beim Antippen braucht die App die
  Verbindung nach Hause.
- **Ohne VPN zeigt die installierte App keine Daten.** Sie startet, erreicht
  den Server aber nicht. Einschalten genügt, ein Neustart der App ist nicht
  nötig.
- **Gleiches Netz am anderen Ende.** Bist du in einem fremden WLAN, das
  zufällig denselben Adressbereich nutzt wie dein Heimnetz (bei FRITZ!Boxen
  häufig `192.168.178.x`), kann das Smartphone die Adresse zu Hause nicht von
  der im fremden Netz unterscheiden. Dann über Mobilfunk verbinden oder das
  eigene Heimnetz dauerhaft auf einen selteneren Bereich umstellen.
- **Zugang wieder entziehen.** Ein verlorenes Smartphone entfernst du in der
  FRITZ!Box unter **VPN (WireGuard)** bzw. in der Tailscale-Verwaltung. Die
  angemeldete postbuch.net-Sitzung auf dem Gerät beendet erst eine
  Passwortänderung der betroffenen Person (siehe
  [Wenn ein Zugang endet](sicherheit.md#wenn-ein-zugang-endet)).

---

Weiter: [Sicherheit](sicherheit.md) · [Zurück zur Übersicht](README.md)
