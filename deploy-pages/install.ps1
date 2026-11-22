# postbuch.net - Installation unter Windows (WSL 2)
#
# Aufruf in einer PowerShell "Als Administrator":
#   irm https://github.com/ceramgcf/postbuch.net/releases/latest/download/install.ps1 | iex
# Entfernen:
#   & ([scriptblock]::Create((irm https://github.com/ceramgcf/postbuch.net/releases/latest/download/install.ps1))) -Deinstallieren
#
# Richtet nur den Windows-Teil ein und uebergibt dann an install.sh in einer
# eigenen WSL-Instanz "postbuch.net" (Debian). Dort laufen Signaturpruefung,
# Einrichtungsdialog und Stack wie unter Linux. Jeder Schritt prueft zuerst,
# ob er schon erledigt ist; nach einem noetigen Neustart denselben Befehl
# einfach noch einmal ausfuehren.
#
# Bewusst reines ASCII: Windows PowerShell 5.1 liest Skripte ohne BOM in der
# Systemcodepage. Ausgaben von wsl.exe werden nie als Text ausgewertet, nur
# Exit-Codes (die Kodierung ihrer Meldungen schwankt). Das Skript laeuft per
# iex in der Sitzung des Nutzers: deshalb alles in einem eigenen
# Gueltigkeitsbereich und nie "exit", das sein Fenster schliessen wuerde.
#
# Parameter:
#   -Deinstallieren           postbuch.net entfernen: Sicherung, Stack, geplante
#                             Aufgabe, Verknuepfung und WSL-Instanz. Die Ablage
#                             mit den Originalen bleibt erhalten.
#   -Netzwerkfreigabe an|aus   Windows-Freigabe aendern.
#   -Quelle <https-url>       andere Bezugsquelle (an install.sh durchgereicht)
#   -InstallerUrl <https-url> install.sh von dieser Adresse statt vom Release
#   -Zielversion <x.y.z>      genau diese Version installieren, auch eine
#                             Vorabversion (GitHub): install.sh kommt dann aus
#                             diesem Release und bekommt --zielversion.
#   -WebPort <n>              Port der Weboberflaeche (Standard 3420)
#   -HttpPort <n>             Port fuer HTTP mit DuckDNS (Standard 80)
#   -HttpsPort <n>            Port fuer HTTPS mit DuckDNS (Standard 443)
#                             Bei einer bestehenden Installation stellen die
#                             Port-Schalter die Ports um. Ohne Schalter waehlt
#                             die Erstinstallation fuer belegte Standardports
#                             selbst freie.

param(
    [switch]$Deinstallieren,
    [ValidateSet('an', 'aus')][string]$Netzwerkfreigabe,
    [string]$Quelle = '',
    [string]$InstallerUrl = '',
    [string]$Zielversion = '',
    [int]$WebPort = 0,
    [int]$HttpPort = 0,
    [int]$HttpsPort = 0
)

& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Instanz = 'postbuch.net'
$Aufgabe = 'postbuch.net Wachhalten'
$WslExe = "$env:SystemRoot\System32\wsl.exe"
$Abbruchmarke = 'postbuch.net-Abbruch:'
$WslConfig = Join-Path $env:USERPROFILE '.wslconfig'
$WslMarke = '# postbuch.net: Zugriff im Heimnetz'
$WslMarkeSpeicher = '# postbuch.net: Speicher fuer die lokale KI'
# Grenzen der lokalen KI wie in scripts/postbuch-hostconfig.sh (MiB).
$LokalKiMinMiB = 22888   # Arbeitsspeicher + Grafikspeicher zusammen (24 GB)
$WindowsRestMiB = 8192   # so viel behaelt Windows mindestens
$WslPufferMiB = 512      # zieht der Linux-Kern vom zugeteilten Speicher ab
$FwRegel = 'postbuch.net-Heimnetz'
$WslVmCreator = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\postbuch.net'
$Verwaltung = Join-Path $env:LOCALAPPDATA 'postbuch.net'
$HeimnetzWahl = Join-Path $Verwaltung 'heimnetz.txt'
# Ohne -InstallerUrl: install.sh aus dem neuesten stabilen Release, mit
# -Zielversion aus genau diesem Release. GitHubs "latest" kennt nur stabile
# Releases; eine Vorabversion ist nur unter ihrer Versionsnummer erreichbar.
$StandardInstallerUrl = 'https://github.com/ceramgcf/postbuch.net/releases/latest/download/install.sh'
$ZielversionOk = $Zielversion -match '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
if (-not $InstallerUrl) {
    $InstallerUrl = if ($ZielversionOk) { "https://github.com/ceramgcf/postbuch.net/releases/download/v$Zielversion/install.sh" } else { $StandardInstallerUrl }
}
$Ps1Url = $InstallerUrl -replace 'install\.sh$', 'install.ps1'

# Jede Ausgabe stellt zuerst den Konsolenmodus vom Skriptstart wieder her
# (siehe Konsole-Zuruecksetzen): Auch kurze wsl.exe-Abfragen ohne eigenes
# Zuruecksetzen lassen sonst die folgenden Zeilen nach rechts rutschen.
function Info   { param($t); Konsole-Zuruecksetzen; Write-Host "  $t" }
function Ok     { param($t); Konsole-Zuruecksetzen; Write-Host "  [ok] $t" -ForegroundColor Green }
function Hinweis{ param($t); Konsole-Zuruecksetzen; Write-Host "  [!] $t" -ForegroundColor Yellow }
function Abbruch{ param($t); throw "$Abbruchmarke$t" }

# Native Aufrufe mit lokal abgeschaltetem 'Stop': Windows PowerShell 5.1 macht
# sonst aus jeder stderr-Zeile einen abbrechenden Fehler.
# wsl.exe stellt die Konsole fuer Linux-Ausgaben um (u. a. kein automatischer
# Zeilenanfang nach einem Zeilenumbruch). Endet ein Aufruf, bevor es das
# zuruecknimmt, rutscht jede weitere Zeile in diesem Fenster nach rechts.
# Deshalb nach jedem Aufruf den Modus vom Skriptstart wiederherstellen.
$KonsoleModus = $null
try {
    Add-Type -Namespace PostbuchNet -Name Konsole -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@ -ErrorAction Stop
    $KonsoleModus = @{}
    foreach ($n in -10, -11) {
        $m = [uint32]0
        if ([PostbuchNet.Konsole]::GetConsoleMode([PostbuchNet.Konsole]::GetStdHandle($n), [ref]$m)) { $KonsoleModus[$n] = $m }
    }
} catch { $KonsoleModus = $null }

function Konsole-Zuruecksetzen {
    if (-not $KonsoleModus) { return }
    foreach ($n in $KonsoleModus.Keys) {
        $null = [PostbuchNet.Konsole]::SetConsoleMode([PostbuchNet.Konsole]::GetStdHandle($n), $KonsoleModus[$n])
    }
}

function Wsl {
    # Nicht interaktiv; Ausgabe auf die Konsole, Rueckgabe nur der Exit-Code.
    $ErrorActionPreference = 'Continue'
    & $WslExe @args | Out-Host
    $rc = $LASTEXITCODE
    Konsole-Zuruecksetzen
    return $rc
}

function Wsl-Bash([string]$skript) {
    # Skript per stdin an bash in der Instanz, ohne Anfuehrungszeichen-Verschachtelung.
    # PowerShell 5.1 haengt beim Pipen an ein natives Programm CRLF an; die
    # abschliessende Kommentarzeile nimmt das CR auf, sonst endet die letzte
    # Befehlszeile auf "\r" (z. B. "}\r" -> Syntaxfehler).
    $ErrorActionPreference = 'Continue'
    (($skript -replace "`r", '') + "`n# Ende") | & $WslExe -d $Instanz -u root -- bash -s | Out-Host
    $rc = $LASTEXITCODE
    Konsole-Zuruecksetzen
    return $rc
}

function Wsl-Terminal([string]$befehl) {
    # Interaktiv: install.sh braucht das Terminal fuer seine Fragen. Start-Process
    # reicht die Konsole unveraendert durch (keine Pipeline dazwischen).
    $p = Start-Process -FilePath $WslExe -ArgumentList "-d $Instanz -u root -- bash -c `"$befehl`"" -NoNewWindow -Wait -PassThru
    Konsole-Zuruecksetzen
    return $p.ExitCode
}

function Wsl-Version-Ok {
    if (-not (Test-Path $WslExe)) { return $false }
    $ErrorActionPreference = 'Continue'
    $null = & $WslExe --version 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Standby-Minuten {
    $ErrorActionPreference = 'Continue'
    $z = powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null | Select-String 'AC.*0x([0-9a-f]+)' | Select-Object -First 1
    if (-not $z) { return 0 }
    return [Convert]::ToInt32($z.Matches[0].Groups[1].Value, 16) / 60
}

function Instanz-Vorhanden {
    $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (-not (Test-Path $lxss)) { return $false }
    foreach ($k in Get-ChildItem $lxss) {
        if ((Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).DistributionName -eq $Instanz) { return $true }
    }
    return $false
}

# -- Heimnetz -----------------------------------------------------------------
# Andere Geraete (Handy) erreichen die Instanz nur im gespiegelten WSL-Netz.
# hostAddressLoopback laesst zusaetzlich die eigene Heimnetz-Adresse am PC zu.
# Die .wslconfig gilt fuer alle WSL-Instanzen des Benutzers: vorhandene Werte
# bleiben unangetastet, eigene Zeilen stehen hinter einer Markierung und
# verschwinden beim Deinstallieren wieder.

function Ini-Wert {
    param($zeilen, [string]$abschnitt, [string]$schluessel)
    $drin = $false
    foreach ($l in $zeilen) {
        $t = $l.Trim()
        if ($t -match '^\[(.+)\]$') { $drin = ($Matches[1].Trim() -ieq $abschnitt); continue }
        if ($drin -and $t -match "^(?i)$schluessel\s*=\s*(.*)$") { return $Matches[1].Trim() }
    }
    return $null
}

function Ist-Marke([string]$l) { return $l -like '# postbuch.net:*' }

function Ini-Setzen {
    param($zeilen, [string]$abschnitt, [string]$schluessel, [string]$wert, [string]$marke = $WslMarke)
    $kopf = -1
    for ($i = 0; $i -lt $zeilen.Count; $i++) {
        if ($zeilen[$i].Trim() -ieq "[$abschnitt]") { $kopf = $i; break }
    }
    if ($kopf -lt 0) {
        if ($zeilen.Count -gt 0 -and $zeilen[$zeilen.Count - 1].Trim() -ne '') { $zeilen.Add('') }
        $zeilen.Add($marke); $zeilen.Add("[$abschnitt]")
        $kopf = $zeilen.Count - 1
    }
    $zeilen.Insert($kopf + 1, $marke)
    $zeilen.Insert($kopf + 2, "$schluessel=$wert")
}

function WslConfig-Lesen {
    $z = New-Object 'System.Collections.Generic.List[string]'
    if (Test-Path $WslConfig) { foreach ($l in [IO.File]::ReadAllLines($WslConfig)) { $z.Add($l) } }
    return ,$z
}

function WslConfig-Schreiben {
    param($zeilen)
    [IO.File]::WriteAllLines($WslConfig, [string[]]$zeilen, (New-Object Text.UTF8Encoding($false)))
}

function WSL-Laeuft {
    return [bool](Get-Process -Name vmmemWSL -ErrorAction SilentlyContinue)
}

# Namen laufender Instanzen ausser postbuch.net. Ohne laufende Instanz meldet
# wsl.exe einen Fehlercode; dann ist die Liste leer.
function Andere-Laufende-Instanzen {
    $ErrorActionPreference = 'Continue'
    $namen = @(& $WslExe --list --running --quiet 2>$null)
    $rc = $LASTEXITCODE
    Konsole-Zuruecksetzen
    if ($rc -ne 0) { return @() }
    return @($namen | ForEach-Object { "$_".Trim([char]0, ' ', "`t") } | Where-Object { $_ -and $_ -ne $Instanz })
}

function Heimnetz-Einrichten {
    if ([Environment]::OSVersion.Version.Build -lt 22621) {
        Hinweis 'Zugriff aus dem Heimnetz (z. B. vom Handy) braucht Windows 11 ab Version 22H2.'
        Info    'postbuch.net ist dann nur an diesem PC erreichbar.'
        return $false
    }
    if (-not (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue)) {
        Hinweis 'Die Hyper-V-Firewall fuer WSL ist auf diesem Windows nicht verfuegbar.'
        return $false
    }
    $z = WslConfig-Lesen
    $modus = Ini-Wert $z 'wsl2' 'networkingMode'
    if ($modus -and $modus -ine 'mirrored') {
        Hinweis "In $WslConfig steht networkingMode=$modus. Das bleibt so; postbuch.net ist dann nur an diesem PC erreichbar."
        return $false
    }
    $geaendert = $false
    if (-not $modus) { Ini-Setzen $z 'wsl2' 'networkingMode' 'mirrored'; $geaendert = $true }
    if ($null -eq (Ini-Wert $z 'experimental' 'hostAddressLoopback')) {
        Ini-Setzen $z 'experimental' 'hostAddressLoopback' 'true'; $geaendert = $true
    }
    if ($geaendert) {
        WslConfig-Schreiben $z
        Ok "WSL-Netz auf 'gespiegelt' gestellt ($WslConfig)."
        WSL-Neustarten 'das gespiegelte Netz' 'Das Heimnetz'
    }
    return $true
}

# Laeuft WSL noch (auch kurz nach einer Deinstallation), gilt eine geaenderte
# .wslconfig erst nach einem Neustart von WSL. Ohne andere laufende
# Linux-Instanzen geschieht das gleich hier.
function WSL-Neustarten {
    param([string]$was, [string]$satzanfang)
    if (-not (WSL-Laeuft)) { return }
    $andere = @(Andere-Laufende-Instanzen)
    if ($andere.Count -eq 0) {
        Info "Starte WSL neu, damit $was gleich gilt ..."
        $null = Wsl --shutdown
        Ok 'WSL neu gestartet.'
    } else {
        Hinweis "Es laufen weitere Linux-Instanzen ($($andere -join ', ')). $satzanfang wirkt nach 'wsl --shutdown' oder dem naechsten Neustart von Windows."
    }
}

# -- Speicher fuer die lokale KI ----------------------------------------------
# WSL bekommt standardmaessig die Haelfte des Arbeitsspeichers. Reicht das
# zusammen mit dem Grafikspeicher nicht fuer die lokale KI (24 GB), der ganze
# Rechner aber schon, bietet der Installer an, WSL gerade so viel mehr zu
# geben wie noetig. Windows behaelt dabei mindestens 8 GB. Ein vorhandener
# memory-Eintrag bleibt unangetastet.

function Groesse-MiB([string]$wert) {
    if ($wert -notmatch '^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)B?\s*$') { return $null }
    $zahl = [double]$Matches[1]
    switch ($Matches[2].ToUpper()) {
        'T' { return [long]($zahl * 1024 * 1024) }
        'G' { return [long]($zahl * 1024) }
        'M' { return [long]$zahl }
        'K' { return [long]($zahl / 1024) }
        default { return [long]($zahl / 1MB) }
    }
}

function Grafikspeicher-MiB {
    $smi = "$env:SystemRoot\System32\nvidia-smi.exe"
    if (-not (Test-Path $smi)) { return 0 }
    $ErrorActionPreference = 'Continue'
    $roh = @(& $smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null)
    Konsole-Zuruecksetzen
    $max = 0
    foreach ($z in $roh) { if ("$z".Trim() -match '^\d+$' -and [int]"$z".Trim() -gt $max) { $max = [int]"$z".Trim() } }
    return $max
}

function Arbeitsspeicher-MiB { return [long]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB) }

function Speicher-Anbieten {
    $ramMiB = Arbeitsspeicher-MiB
    $vramMiB = Grafikspeicher-MiB
    $z = WslConfig-Lesen
    $eingetragen = Ini-Wert $z 'wsl2' 'memory'
    $wslMiB = if ($eingetragen) { Groesse-MiB $eingetragen } else { [long]($ramMiB / 2) }
    if ($null -eq $wslMiB) { return }
    # Reicht es schon (etwa dank der Grafikkarte), wird nichts angeboten.
    if ($wslMiB - $WslPufferMiB + $vramMiB -ge $LokalKiMinMiB) { return }
    $noetigGB = [int][math]::Ceiling(($LokalKiMinMiB - $vramMiB + $WslPufferMiB) / 1024)
    # Nur anbieten, wenn Windows danach noch mindestens 8 GB bleiben.
    if ($ramMiB - $noetigGB * 1024 -lt $WindowsRestMiB) { return }
    if ($eingetragen) {
        Hinweis "In $WslConfig ist der Speicher fuer WSL auf $eingetragen begrenzt. Fuer die lokale KI waeren $noetigGB GB noetig; der Eintrag bleibt, wie er ist."
        return
    }
    $gbRam = [math]::Round($ramMiB / 1024)
    Write-Host ""
    Hinweis 'Speicher fuer die eingebaute lokale KI'
    Info    "WSL darf hier bisher hoechstens die Haelfte des Arbeitsspeichers nutzen (rund $([math]::Round($ramMiB / 2048)) von $gbRam GB)."
    Info    "Das reicht$(if ($vramMiB -gt 0) { ' zusammen mit dem Grafikspeicher' }) nicht fuer die lokale KI (24 GB)."
    Info    "Mit einer Grenze von $noetigGB GB ginge es; Windows behaelt dann mindestens $($gbRam - $noetigGB) GB."
    Info    'Belegt wird der Speicher nur, solange WSL ihn braucht, danach bekommt Windows ihn zurueck.'
    Write-Host ""
    Hinweis "ACHTUNG: Die Einstellung steht in $WslConfig und gilt fuer ALLE WSL-Umgebungen"
    Hinweis 'auf diesem PC (z. B. Ubuntu oder Docker Desktop), nicht nur fuer postbuch.net.'
    Hinweis 'Sie koennen dann ebenfalls bis zu dieser Grenze Speicher belegen.'
    Info    'Beim Deinstallieren von postbuch.net wird der Eintrag wieder entfernt.'
    Info    'Ohne lokale KI (KI per API-Schluessel) ist das nicht noetig.'
    Write-Host ""
    if ((Read-Host "  WSL bis zu $noetigGB GB Arbeitsspeicher geben? [j/N]") -notmatch '^[jJ]') {
        Info 'Unveraendert. Die lokale KI laesst sich dann nicht einrichten.'
        return
    }
    Ini-Setzen $z 'wsl2' 'memory' "$($noetigGB)GB" $WslMarkeSpeicher
    WslConfig-Schreiben $z
    Ok "WSL darf jetzt bis zu $noetigGB GB Arbeitsspeicher nutzen ($WslConfig)."
    WSL-Neustarten 'die neue Speichergrenze' 'Die neue Speichergrenze'
}

# Die gespeicherte Zustimmung gilt auch nach einem Neustart waehrend der Installation.
function Heimnetz-Wahl-Speichern {
    param([bool]$an)
    New-Item -ItemType Directory -Force -Path $Verwaltung | Out-Null
    Set-Content -LiteralPath $HeimnetzWahl -Value $(if ($an) { 'an' } else { 'aus' }) -Encoding ASCII
}

function Firewall-Regel {
    if (Get-Command Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
        Get-NetFirewallHyperVRule -ErrorAction Stop | Where-Object { $_.Name -eq $FwRegel }
    }
}

function Firewall-Entfernen {
    if (Firewall-Regel) {
        Remove-NetFirewallHyperVRule -Name $FwRegel -ErrorAction Stop
        Ok 'Firewall-Freigabe fuer postbuch.net entfernt.'
    }
}

# Die Regel umfasst die Netzwerk-Ports der Weboberflaeche und eines
# eingerichteten HTTPS-Zugangs.
function Firewall-Setzen {
    param($ports)
    if (-not (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue)) {
        Abbruch 'Die Hyper-V-Firewall ist auf diesem Windows nicht verfuegbar.'
    }
    $liste = @(
        if (-not $ports.WebLokal) { $ports.Web }
        if ($ports.HttpsAktiv) { $ports.Http; $ports.Https }
    ) | Sort-Object -Unique
    if (-not $liste -or ($liste | Where-Object { $_ -lt 1 -or $_ -gt 65535 })) {
        Abbruch 'Keine gueltigen Web-Ports fuer die Netzwerkfreigabe gefunden.'
    }
    $regel = Firewall-Regel
    if ($regel) {
        Set-NetFirewallHyperVRule -Name $FwRegel -Direction Inbound -Protocol TCP -LocalPorts $liste -Action Allow -Profiles Private -Enabled True -ErrorAction Stop | Out-Null
    } else {
        New-NetFirewallHyperVRule -Name $FwRegel -DisplayName 'postbuch.net (Netzwerkzugriff)' -Direction Inbound `
            -VMCreatorId $WslVmCreator -Protocol TCP -LocalPorts $liste -Action Allow -Profiles Private -ErrorAction Stop | Out-Null
    }
    Ok "Firewall: Eingehendes TCP auf Ports $($liste -join ', ') fuer postbuch.net freigegeben."
}

function Heimnetz-Zustimmung {
    if ([Environment]::OSVersion.Version.Build -lt 22621) {
        Info 'Die Netzwerkfreigabe braucht Windows 11 ab Version 22H2. postbuch.net ist an diesem PC nutzbar.'
        return $false
    }
    if (Test-Path -LiteralPath $HeimnetzWahl) {
        return (Get-Content -LiteralPath $HeimnetzWahl -TotalCount 1) -eq 'an'
    }
    Write-Host ''
    Info 'Netzwerkzugriff fuer postbuch.net'
    Info 'Mit der Freigabe koennen andere Geraete im Netzwerk die Anmeldeseite erreichen.'
    Info 'Der Installer erlaubt dafuer eingehendes TCP zu den Web-Ports in der Hyper-V-Firewall (Windows-Netzwerkprofil Privat).'
    Info 'Der Installer bereitet das gespiegelte Netz fuer alle WSL-Instanzen dieses Windows-Kontos vor.'
    Info 'Ohne Freigabe kannst du postbuch.net an diesem PC nutzen.'
    Info 'Spaeter aenderbar unter Windows-Einstellungen > Apps > Installierte Apps > postbuch.net Server > Aendern.'
    do {
        $wahl = (Read-Host '  Netzwerkzugriff erlauben? [J/n]').Trim()
    } until ($wahl -match '^(j|ja|n|nein)?$')
    $an = $wahl -notmatch '^(n|nein)$'
    Heimnetz-Wahl-Speichern $an
    return $an
}

# -- Ports ---------------------------------------------------------------------
# Im gespiegelten WSL-Netz teilen sich Windows und die Instanz die Ports. Ein
# Windows-Dienst auf 80/443/3420 (IIS, Skype, ein anderer Webserver) ist aus
# der Instanz heraus nicht zu sehen; deshalb prueft dieser Teil vorher.

function Port-Belegt([int]$p) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue |
         Where-Object {
             $n = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
             $n -notin @('wslrelay', 'wslservice', 'vmmem', 'vmmemWSL')
         }
    return [bool]$c
}

function Freier-Port([int]$start, $vergeben) {
    for ($p = $start; $p -lt $start + 200 -and $p -le 65535; $p++) {
        if ($vergeben -notcontains $p -and -not (Port-Belegt $p)) { return $p }
    }
    Abbruch "Kein freier Port ab $start gefunden."
}

function Port-Pruefen([int]$p, [string]$schalter) {
    if ($p -lt 1 -or $p -gt 65535) { Abbruch "-$schalter braucht eine Zahl von 1 bis 65535." }
    if (Port-Belegt $p) { Abbruch "Port $p ist unter Windows schon belegt. Bitte mit -$schalter einen anderen waehlen." }
}

# Ports der Instanz aus ihrer .env, sonst die Standards.
function Instanz-Ports {
    $ErrorActionPreference = 'Continue'
    $roh = & $WslExe -d $Instanz -u root -- sh -c "test -r /root/postbuch/.env || exit 2; grep -E '^(WEB_PORT|CADDY_HTTP_PORT|CADDY_HTTPS_PORT|WEB_BIND|COMPOSE_PROFILES)=' /root/postbuch/.env || exit 0"
    if ($LASTEXITCODE -ne 0) { Abbruch 'Die Web-Ports der WSL-Instanz konnten nicht gelesen werden.' }
    $r = [ordered]@{ Web = 3420; Http = 80; Https = 443; WebLokal = $false; HttpsAktiv = $false }
    foreach ($z in @($roh)) {
        if ("$z" -match '^WEB_PORT=(\d+)') { $r.Web = [int]$Matches[1] }
        elseif ("$z" -match '^CADDY_HTTP_PORT=(\d+)') { $r.Http = [int]$Matches[1] }
        elseif ("$z" -match '^CADDY_HTTPS_PORT=(\d+)') { $r.Https = [int]$Matches[1] }
        elseif ("$z" -match '^WEB_BIND=(.*)$') { $r.WebLokal = $Matches[1].Trim([char]39, [char]34) -in @('127.0.0.1', '::1', '[::1]') }
        elseif ("$z" -match '^COMPOSE_PROFILES=(.*)$') { $r.HttpsAktiv = $Matches[1].Trim([char]39, [char]34).Split(',') -contains 'caddy' }
    }
    return $r
}

# Steht nach install.sh noch eine Sicherung zum Einspielen aus (im Browser)?
function Restore-Offen {
    $ErrorActionPreference = 'Continue'
    $null = & $WslExe -d $Instanz -u root -- test -f /root/postbuch/data/scan_buffer/.setup_restore_pending
    $rc = $LASTEXITCODE
    Konsole-Zuruecksetzen
    return ($rc -eq 0)
}

function Installation-Vorhanden {
    if (-not (Instanz-Vorhanden)) { return $false }
    $ErrorActionPreference = 'Continue'
    $null = & $WslExe -d $Instanz -u root -- test -f /root/postbuch/.env
    return ($LASTEXITCODE -eq 0)
}

# -- Programme und Features --------------------------------------------------
# Eintrag fuer den angemeldeten Benutzer (die WSL-Instanz gehoert ihm). Aendern
# und Deinstallieren laufen ueber ein kleines Skript, das sich die aktuelle
# install.ps1 von derselben Quelle holt und dafuer Administratorrechte anfordert.

# Was die lokale KI nach diesem Lauf noch auf die Platte bringt (0 ohne lokale
# KI): Modelldateien laut Katalog minus dem, was schon im Modellordner liegt,
# plus ihr Programm-Image, falls es noch fehlt.
function Lokalki-Restbytes {
    $ErrorActionPreference = 'Continue'
    $envText = (& $WslExe -d $Instanz -u root -- cat /root/postbuch/.env 2>$null) -join "`n"
    if ($envText -notmatch '(?m)^POSTBUCH_KI=lokal\s*$') { return 0 }
    $kat = & $WslExe -d $Instanz -u root -- cat /root/postbuch/app/src/lib/llm/lokal-modelle.kv 2>$null
    [long]$soll = 0
    foreach ($z in $kat) {
        $f = "$z".Split('|')
        if ($f.Count -eq 6 -and $f[0] -eq 'datei') { $soll += [long]$f[4] }
    }
    $du = (& $WslExe -d $Instanz -u root -- du -sb /root/postbuch/data/modelle 2>$null | Select-Object -First 1)
    [long]$da = 0
    if ("$du" -match '^(\d+)') { $da = [long]$Matches[1] }
    [long]$rest = [math]::Max([long]0, $soll - $da)
    # Das Programm der lokalen KI zieht der Agent ebenfalls erst danach.
    # Ungefaehre entpackte Groesse des llama.cpp-Images: mit NVIDIA CUDA
    # rund 4,4 GB, ohne rund 1,2 GB.
    $img = (& $WslExe -d $Instanz -u root -- docker image ls -q ghcr.io/ggml-org/llama.cpp 2>$null | Select-Object -First 1)
    if (-not "$img".Trim()) {
        if ($envText -match '(?m)^POSTBUCH_CUDA_ZUSTIMMUNG=\S') { $rest += [long]4400000000 } else { $rest += [long]1200000000 }
    }
    return $rest
}

function Verwaltung-Eintragen($ports, $ico) {
    New-Item -ItemType Directory -Force -Path $Verwaltung | Out-Null
    $skript = Join-Path $Verwaltung 'verwalten.ps1'
    $quelleOpt = if ($Quelle) { " -Quelle '$Quelle'" } else { '' }
    # Stammt der Installer aus einem fest gewaehlten GitHub-Release (-Zielversion),
    # nimmt "Aendern" zuerst das neueste stabile Release und nur ersatzweise (noch
    # kein install.ps1 dort, nicht erreichbar) das Release dieser Installation.
    # Das gilt bei jedem Lauf, auch nach einem "Aendern" ueber die Ersatzadresse.
    # Eine eigene -InstallerUrl (Spiegel, Testquelle) bleibt unveraendert.
    $verwaltungsUrls = @($InstallerUrl)
    if ($InstallerUrl -match '^https://github\.com/ceramgcf/postbuch\.net/releases/download/v[0-9.]+/install\.sh$') {
        $verwaltungsUrls = @($StandardInstallerUrl, $InstallerUrl)
    }
    $inhalt = @"
# postbuch.net - Aendern/Deinstallieren aus "Programme und Features"
param([switch]`$Deinstallieren)
`$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal `$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    `$a = '-NoProfile -ExecutionPolicy Bypass -File "' + `$PSCommandPath + '"'
    if (`$Deinstallieren) { `$a += ' -Deinstallieren' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList `$a
    return
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
`$url = '$InstallerUrl'
`$sb = `$null
foreach (`$u in @('$($verwaltungsUrls -join "', '")')) {
    try { `$sb = [scriptblock]::Create((Invoke-RestMethod (`$u -replace 'install\.sh`$', 'install.ps1'))); `$url = `$u; break } catch { }
}
if (-not `$sb) { Write-Host '  [x] install.ps1 nicht erreichbar. Internetverbindung pruefen.' -ForegroundColor Red; Read-Host '  Enter schliesst dieses Fenster'; return }
if (`$Deinstallieren) { & `$sb -Deinstallieren$quelleOpt -InstallerUrl `$url }
else { & `$sb$quelleOpt -InstallerUrl `$url }
Read-Host '  Enter schliesst dieses Fenster'
"@
    [IO.File]::WriteAllText($skript, $inhalt, (New-Object Text.ASCIIEncoding))
    $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $aufruf = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$skript`""
    $ErrorActionPreference = 'Continue'
    $version = (& $WslExe -d $Instanz -u root -- cat /root/postbuch/VERSION 2>$null | Select-Object -First 1)
    $ErrorActionPreference = 'Stop'
    if (-not (Test-Path $UninstallKey)) { New-Item -Path $UninstallKey -Force | Out-Null }
    # "Server" unterscheidet diesen Eintrag von der als App registrierten
    # Oberflaeche, die der Browser als eigenen Eintrag "postbuch.net" anlegt.
    $werte = @{
        DisplayName = 'postbuch.net Server'
        Publisher = 'postbuch.net'
        URLInfoAbout = 'https://www.postbuch.net'
        HelpLink = "http://localhost:$($ports.Web)/"
        InstallLocation = Join-Path $env:USERPROFILE "wsl\$Instanz"
        DisplayIcon = if ($ico) { $ico } else { "$ps,0" }
        UninstallString = "$aufruf -Deinstallieren"
        ModifyPath = $aufruf
    }
    if ($version) { $werte.DisplayVersion = "$version".Trim() }
    foreach ($k in $werte.Keys) { Set-ItemProperty -Path $UninstallKey -Name $k -Value $werte[$k] }
    # Groesse fuer "Installierte Apps": die virtuelle Platte der Instanz mit
    # Containern und KI-Modellen (in KB). Das Modell der lokalen KI laedt der
    # Host-Agent erst nach diesem Lauf im Hintergrund; was davon noch fehlt,
    # wird dazugerechnet. Sonst haengt die Zahl davon ab, wie weit der
    # Download beim Messen zufaellig war.
    try {
        $bytes = (Get-ChildItem -LiteralPath $werte.InstallLocation -Recurse -File -ErrorAction Stop |
            Measure-Object -Property Length -Sum).Sum
        try { $bytes += Lokalki-Restbytes } catch { }
        if ($bytes) { Set-ItemProperty -Path $UninstallKey -Name EstimatedSize -Value ([int][math]::Min([math]::Ceiling($bytes / 1KB), [int]::MaxValue)) -Type DWord }
    } catch { }
    Set-ItemProperty -Path $UninstallKey -Name NoRepair -Value 1 -Type DWord
    Ok 'Eintrag in "Apps > Installierte Apps" bzw. "Programme und Features" angelegt.'
}

function Verwaltung-Entfernen {
    if (Test-Path $UninstallKey) {
        Remove-Item -Path $UninstallKey -Recurse -Force
        Ok 'Eintrag in "Programme und Features" entfernt.'
    }
    if (Test-Path $Verwaltung) { Remove-Item -Path $Verwaltung -Recurse -Force -ErrorAction SilentlyContinue }
}

# Eigenes Symbol fuer "Programme und Features" und die Verknuepfung: das Logo
# der Weboberflaeche, als PNG in eine .ico-Datei gepackt (Windows liest PNG in
# .ico seit Vista). Scheitert das, bleibt das Symbol von PowerShell.
function Symbol-Anlegen($ports) {
    $ico = Join-Path $Verwaltung 'postbuch.net.ico'
    try {
        New-Item -ItemType Directory -Force -Path $Verwaltung | Out-Null
        Add-Type -AssemblyName System.Drawing
        $roh = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 "http://127.0.0.1:$($ports.Web)/Postbuch-Logo512.png").Content
        $quelle = New-Object Drawing.Bitmap (New-Object IO.MemoryStream (,[byte[]]$roh))
        $bilder = @()
        foreach ($g in 16, 32, 48, 256) {
            $bmp = New-Object Drawing.Bitmap $g, $g
            $gr = [Drawing.Graphics]::FromImage($bmp)
            $gr.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $gr.DrawImage($quelle, 0, 0, $g, $g)
            $gr.Dispose()
            $ms = New-Object IO.MemoryStream
            $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            $bilder += ,@($g, $ms.ToArray())
        }
        $quelle.Dispose()
        $aus = New-Object IO.MemoryStream
        $w = New-Object IO.BinaryWriter $aus
        $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$bilder.Count)
        $versatz = 6 + 16 * $bilder.Count
        foreach ($b in $bilder) {
            $kante = if ($b[0] -ge 256) { 0 } else { $b[0] }
            $w.Write([byte]$kante); $w.Write([byte]$kante); $w.Write([byte]0); $w.Write([byte]0)
            $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$b[1].Length); $w.Write([uint32]$versatz)
            $versatz += $b[1].Length
        }
        foreach ($b in $bilder) { $w.Write([byte[]]$b[1]) }
        $w.Flush()
        [IO.File]::WriteAllBytes($ico, $aus.ToArray())
        return $ico
    } catch {
        return $null
    }
}

function Verknuepfung-Setzen($ports) {
    $link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'postbuch.net.url'
    $url = "http://localhost:$($ports.Web)/"
    if ((Test-Path $link) -and -not (Select-String -Path $link -Pattern '^URL=http://localhost:\d+/' -Quiet)) { return }
    $ico = Join-Path $Verwaltung 'postbuch.net.ico'
    $symbol = if (Test-Path $ico) { "IconFile=$ico`r`nIconIndex=0`r`n" } else { '' }
    if ((Test-Path $link) -and (Select-String -Path $link -SimpleMatch "URL=$url" -Quiet) -and
        ((-not $symbol) -or (Select-String -Path $link -SimpleMatch 'IconFile=' -Quiet))) { return }
    Set-Content -Path $link -Value "[InternetShortcut]`r`nURL=$url`r`n$symbol" -Encoding ASCII
    Ok 'Verknuepfung "postbuch.net" auf dem Desktop angelegt.'
}

function Heimnetz-Entfernen {
    Firewall-Entfernen
    if (-not (Test-Path $WslConfig)) { return }
    $alt = WslConfig-Lesen
    if (-not ($alt | Where-Object { Ist-Marke $_ })) { return }
    # 1. Eigene Schluessel (Markierung vor einer Schluesselzeile).
    $z = New-Object 'System.Collections.Generic.List[string]'
    for ($i = 0; $i -lt $alt.Count; $i++) {
        if ((Ist-Marke $alt[$i]) -and $i + 1 -lt $alt.Count -and $alt[$i + 1].Trim() -notmatch '^\[') { $i++; continue }
        $z.Add($alt[$i])
    }
    # 2. Eigene Abschnittskoepfe nur, wenn der Abschnitt jetzt leer ist.
    $neu = New-Object 'System.Collections.Generic.List[string]'
    for ($i = 0; $i -lt $z.Count; $i++) {
        if (Ist-Marke $z[$i]) {
            $j = $i + 2
            while ($j -lt $z.Count -and $z[$j].Trim() -eq '') { $j++ }
            if ($j -ge $z.Count -or (Ist-Marke $z[$j]) -or $z[$j].Trim() -match '^\[') { $i = $j - 1; continue }
            continue
        }
        $neu.Add($z[$i])
    }
    while ($neu.Count -gt 0 -and $neu[$neu.Count - 1].Trim() -eq '') { $neu.RemoveAt($neu.Count - 1) }
    if ($neu.Count -eq 0) { Remove-Item $WslConfig -Force } else { WslConfig-Schreiben $neu }
    Ok 'Einstellungen von postbuch.net aus der .wslconfig entfernt (wirkt nach dem naechsten Neustart).'
}

# Das Installationsverzeichnis in der Instanz steht fest (/root/postbuch); die
# Funktionen hier lesen .env und VERSION von dort. install.sh fragt dann nicht.
function Installer-Befehl([string]$optionen) {
    return "curl -fsSL '$InstallerUrl' -o /root/install.sh && bash /root/install.sh --install-dir=/root/postbuch $optionen"
}

# Zum Entfernen zuerst die install.sh, die bei der Instanz liegt: Sie passt zur
# installierten Version und braucht kein Internet. Nur wenn sie fehlt oder
# --deinstallieren noch nicht kennt, wird sie heruntergeladen.
function Deinstallations-Befehl {
    $lokal = '/root/postbuch/install.sh'
    return "if [ -f $lokal ] && grep -q -- '--deinstallieren)' $lokal; then bash $lokal --deinstallieren; else $(Installer-Befehl '--deinstallieren'); fi"
}

function Deinstallation {
    Info 'postbuch.net wird von diesem PC entfernt. Die Ablage mit den Originalen bleibt erhalten.'
    Write-Host ""
    $instanzBleibt = $false
    if (Instanz-Vorhanden) {
        # install.sh fragt nach (LOESCHEN), sichert die Datenbank in die Ablage,
        # entfernt den Stack und laesst den Ablageordner stehen.
        $rc = Wsl-Terminal (Deinstallations-Befehl)
        if ($rc -eq 2) { Info 'Deinstallation abgebrochen. postbuch.net bleibt eingerichtet.'; return }
        if ($rc -ne 0 -and $rc -ne 4) { Abbruch "Die Deinstallation in der Instanz ist nicht abgeschlossen (install.sh $rc). Die Instanz bleibt bestehen." }

        # Liegt die Ablage innerhalb der Instanz, ginge sie mit ihr verloren (Exit 10).
        $lage = Wsl-Bash @'
f=/root/.postbuch-ablage-behalten
[ -f "$f" ] || exit 0
a=$(head -n1 "$f")
case "$a" in /mnt/[a-z]/*) rm -f "$f"; exit 0 ;; esac
[ -d "$a" ] || { rm -f "$f"; exit 0; }
echo "  Die Ablage liegt innerhalb der WSL-Instanz: $a"
exit 10
'@
        if ($lage -eq 10) {
            $ziel = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'postbuch.net-Ablage'
            if (Test-Path $ziel) { $ziel = "$ziel-" + (Get-Date -Format 'yyyy-MM-dd-HHmmss') }
            Hinweis 'Mit der Instanz wuerde auch die Ablage geloescht.'
            if ((Read-Host "  Ablage nach $ziel kopieren und danach die Instanz entfernen? [J/n]") -notmatch '^[nN]') {
                # Der Zielpfad geht per WSLENV in die Instanz (/p: als Linux-Pfad), nie als Skripttext.
                $altWslenv = $env:WSLENV
                $env:PB_ZIEL = $ziel
                $env:WSLENV = 'PB_ZIEL/p'
                try {
                    $rc = Wsl-Bash @'
set -e
a=$(head -n1 /root/.postbuch-ablage-behalten)
[ -n "$PB_ZIEL" ] || exit 1
mkdir -p -- "$PB_ZIEL"
cp -r --preserve=timestamps -- "$a/." "$PB_ZIEL/"
z() { find "$1" -type f -printf '%s\n' | awk '{ n++; s += $1 } END { printf "%d|%d", n, s }'; }
[ "$(z "$a")" = "$(z "$PB_ZIEL")" ] || { echo "  Kopie unvollstaendig."; exit 1; }
rm -f /root/.postbuch-ablage-behalten
'@
                } finally {
                    Remove-Item Env:\PB_ZIEL -ErrorAction SilentlyContinue
                    if ($null -eq $altWslenv) { Remove-Item Env:\WSLENV -ErrorAction SilentlyContinue } else { $env:WSLENV = $altWslenv }
                }
                if ($rc -eq 0) { Ok "Ablage kopiert nach $ziel." }
                else { Hinweis 'Die Kopie ist fehlgeschlagen.'; $instanzBleibt = $true }
            } else {
                $instanzBleibt = $true
            }
        }
    }

    if (Get-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $Aufgabe -Confirm:$false -ErrorAction Stop
        Ok "Geplante Aufgabe '$Aufgabe' entfernt."
    }
    Heimnetz-Entfernen
    $link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'postbuch.net.url'
    if ((Test-Path $link) -and (Select-String -Path $link -Pattern '^URL=http://localhost:\d+/' -Quiet)) {
        Remove-Item $link -Force
        Ok 'Verknuepfung auf dem Desktop entfernt.'
    }
    if (-not $instanzBleibt) { Verwaltung-Entfernen }
    if ($instanzBleibt) {
        Write-Host ""
        Hinweis "Die WSL-Instanz $Instanz bleibt bestehen, damit die Ablage nicht verloren geht."
        Info    "Nach dem Sichern der Ablage entfernt sie: wsl --unregister $Instanz"
    } elseif (Instanz-Vorhanden) {
        $null = Wsl --terminate $Instanz
        $rc = Wsl --unregister $Instanz
        if ($rc -ne 0) { Abbruch "Die WSL-Instanz liess sich nicht entfernen (wsl $rc)." }
        $ort = Join-Path $env:USERPROFILE "wsl\$Instanz"
        if ((Test-Path $ort) -and -not (Get-ChildItem $ort -Force)) { Remove-Item $ort -Force }
        Ok "WSL-Instanz $Instanz entfernt."
    }
    Write-Host ""
    Ok 'postbuch.net ist entfernt.'
    Write-Host ""
}

# Nur die eigenen WSL-Schluessel setzen. Andere Abschnitte und Werte bleiben erhalten.
function Instanz-Konfigurieren {
    $rc = Wsl-Bash @'
set -e
datei=/etc/wsl.conf
tmp=$(mktemp /etc/.postbuch-wsl.XXXXXX)
trap 'rm -f -- "$tmp"' EXIT
eingabe=$datei
[ -e "$datei" ] || eingabe=/dev/null
awk '
  function ergaenzen() {
    if (abschnitt == "boot") {
      boot=1
      print "systemd=true"
    }
    if (abschnitt == "interop") {
      interop=1
      print "enabled=false"
      print "appendWindowsPath=false"
    }
  }
  /^[[:space:]]*\[[^]]+\]/ {
    ergaenzen()
    abschnitt=$0
    sub(/^[[:space:]]*\[/, "", abschnitt)
    sub(/\].*$/, "", abschnitt)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", abschnitt)
    abschnitt=tolower(abschnitt)
  }
  abschnitt == "boot" && tolower($0) ~ /^[[:space:]]*systemd[[:space:]]*=/ { next }
  abschnitt == "interop" && tolower($0) ~ /^[[:space:]]*(enabled|appendwindowspath)[[:space:]]*=/ { next }
  { print }
  END {
    ergaenzen()
    if (!boot) { print "[boot]"; print "systemd=true" }
    if (!interop) { print "[interop]"; print "enabled=false"; print "appendWindowsPath=false" }
  }
' "$eingabe" > "$tmp"
if cmp -s -- "$tmp" "$datei"; then exit 0; fi
chmod 644 "$tmp"
mv -Tf -- "$tmp" "$datei"
exit 42
'@
    if ($rc -ne 0 -and $rc -ne 42) { Abbruch "WSL-Konfiguration konnte nicht gesichert werden ($rc)." }
    if ($rc -eq 42) {
        Info 'Starte die WSL-Instanz von postbuch.net mit der geschuetzten Konfiguration neu.'
        Stop-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue
        $r = Wsl --terminate $Instanz
        if ($r -ne 0) { Abbruch "WSL-Instanz konnte nicht beendet werden ($r)." }
    }
}

function Wachhalten-Einrichten {
    $task = Get-ScheduledTask -TaskName $Aufgabe -ErrorAction SilentlyContinue
    if (-not $task) {
        $aktion = New-ScheduledTaskAction -Execute $WslExe -Argument "-d $Instanz -u root --exec /bin/sleep infinity"
        $ausloeser = New-ScheduledTaskTrigger -AtStartup
        $wer = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $konto = New-ScheduledTaskPrincipal -UserId $wer -LogonType S4U -RunLevel Limited
        $einst = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
        $task = Register-ScheduledTask -TaskName $Aufgabe -Action $aktion -Trigger $ausloeser -Principal $konto -Settings $einst `
            -Description 'Startet postbuch.net beim Hochfahren und haelt die WSL-Instanz wach.' -ErrorAction Stop
        Ok 'Windows-Aufgabe zum Wachhalten mit normalen Benutzerrechten eingerichtet.'
    }
    if ("$($task.Principal.RunLevel)" -ne 'Limited') { Abbruch 'Wachhalten muss mit normalen Windows-Rechten laufen.' }
    if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $Aufgabe -ErrorAction Stop }
}

# Letzter vom Installer gepruefter Zustand. Aus WSL werden keine Auftraege gelesen.
function Firewall-Status-Schreiben {
    $aktiv = $null
    if (Get-Command Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
        $regel = Firewall-Regel
        $aktiv = [bool]($regel -and "$($regel.Enabled)" -eq 'True')
    }
    $status = @{ aktiv = $aktiv; zeit = [DateTime]::UtcNow.ToString('o') }
    $daten = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($status | ConvertTo-Json -Compress)))
    $schreiben = 'cd /root/postbuch/data/update && tmp=$(mktemp .firewall.XXXXXX) && printf %s ' + $daten +
        ' | base64 -d > $tmp && chmod 644 $tmp && mv -Tf -- $tmp firewall-status.json'
    if ((Wsl -d $Instanz -u root --exec sh -c $schreiben) -ne 0) {
        Hinweis 'Der Firewall-Status konnte nicht an postbuch.net uebergeben werden.'
    }
}

function Netzwerkfreigabe-Aendern([string]$wahl) {
    if (-not (Instanz-Vorhanden)) { Abbruch 'Die WSL-Instanz von postbuch.net fehlt.' }
    if (-not (Installation-Vorhanden)) { Abbruch 'postbuch.net ist in WSL noch nicht eingerichtet.' }
    try {
        if ($wahl -eq 'an') {
            if (-not (Heimnetz-Einrichten)) { Abbruch 'Die Windows-Netzwerkeinstellung erlaubt die Freigabe nicht.' }
            Wachhalten-Einrichten
            Firewall-Setzen (Instanz-Ports)
            Heimnetz-Wahl-Speichern $true
        } else {
            Firewall-Entfernen
            Heimnetz-Wahl-Speichern $false
        }
    } finally { Firewall-Status-Schreiben }
}

function Windows-Verwaltungsmenue {
    Info '1  Installation verwalten'
    Info '2  Netzwerkfreigabe aendern'
    $wahl = (Read-Host '  Auswahl [1]').Trim()
    if ($wahl -eq '' -or $wahl -eq '1') { return $false }
    if ($wahl -ne '2') { Abbruch 'Ungueltige Auswahl.' }
    Info '1  Netzwerkfreigabe einschalten'
    Info '2  Netzwerkfreigabe ausschalten'
    switch ((Read-Host '  Auswahl').Trim()) {
        '1' { Netzwerkfreigabe-Aendern 'an' }
        '2' { Netzwerkfreigabe-Aendern 'aus' }
        default { Abbruch 'Ungueltige Auswahl.' }
    }
    return $true
}

function Installation {
    # -- 1. Voraussetzungen -----------------------------------------------------
    if ([Environment]::Is64BitOperatingSystem -eq $false) { Abbruch 'postbuch.net braucht ein 64-Bit-Windows.' }
    $build = [Environment]::OSVersion.Version.Build
    if ($build -lt 19041) { Abbruch "Windows ist zu alt (Build $build). Noetig ist Windows 10 ab Version 2004 oder Windows 11." }

    $cs = Get-CimInstance Win32_ComputerSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    if (-not $cs.HypervisorPresent -and -not $cpu.VirtualizationFirmwareEnabled) {
        Abbruch ('Die Virtualisierung ist im BIOS/UEFI ausgeschaltet. Im BIOS einschalten ' +
                 '(AMD: "SVM Mode", Intel: "Intel Virtualization Technology" bzw. "VT-x"), ' +
                 'Windows starten und den Befehl erneut ausfuehren.')
    }
    $opt = ''
    if ($Quelle) {
        if ($Quelle -notmatch '^https://[A-Za-z0-9./_~%:-]+$') { Abbruch 'Ungueltige Bezugsquelle.' }
        $opt = "--quelle=$Quelle"
    }
    if ($ZielversionOk) { $opt = "$opt --zielversion=$Zielversion".Trim() }
    Ok 'Windows und Virtualisierung passen.'
    if ((Test-Path $UninstallKey) -and -not ($WebPort -or $HttpPort -or $HttpsPort -or $Zielversion) -and
        (Windows-Verwaltungsmenue)) { return }
    $heimnetzGewuenscht = Heimnetz-Zustimmung
    if (-not $heimnetzGewuenscht) { Firewall-Entfernen }

    # -- 2. WSL -----------------------------------------------------------------
    # Der in Windows eingebaute wsl.exe-Platzhalter kennt die noetigen Optionen
    # nicht. Deshalb das aktuelle WSL-Paket von Microsoft (GitHub) installieren,
    # sofern "wsl --version" nicht schon funktioniert.
    if (-not (Wsl-Version-Ok)) {
        Info 'Lade WSL von Microsoft (github.com/microsoft/WSL) ...'
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/microsoft/WSL/releases/latest' -Headers @{ 'User-Agent' = 'postbuch.net-installer' }
        $asset = $rel.assets | Where-Object { $_.name -like "*.$arch.msi" } | Select-Object -First 1
        if (-not $asset) { Abbruch 'WSL-Paket nicht gefunden. Bitte spaeter erneut versuchen.' }
        $msi = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msi -UseBasicParsing
        if ($asset.digest -match '^sha256:([0-9a-f]{64})$') {
            if ((Get-FileHash $msi -Algorithm SHA256).Hash.ToLower() -ne $Matches[1]) {
                Remove-Item $msi -Force; Abbruch 'Pruefsumme des WSL-Pakets stimmt nicht.'
            }
        }
        $sig = Get-AuthenticodeSignature $msi
        if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
            Remove-Item $msi -Force; Abbruch 'Das WSL-Paket ist nicht gueltig von Microsoft signiert.'
        }
        $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
        Remove-Item $msi -Force -ErrorAction SilentlyContinue
        if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Abbruch "WSL-Installation fehlgeschlagen (msiexec $($p.ExitCode))." }
        Ok 'WSL installiert.'
    }

    $vmp = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
    if ($vmp.State -ne 'Enabled') {
        $null = Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart -All
        Write-Host ""
        Hinweis 'Windows muss einmal neu starten, damit WSL laeuft.'
        Info    'Danach PowerShell wieder "Als Administrator" oeffnen und denselben Befehl erneut eingeben.'
        Write-Host ""
        if ((Read-Host '  Jetzt neu starten? [j/N]') -match '^[jJ]') { Restart-Computer }
        return
    }
    Ok 'WSL ist bereit.'

    # Vor dem Anlegen der Instanz, damit sie gleich im gespiegelten Netz und
    # mit der passenden Speichergrenze startet.
    $heimnetzBereit = Heimnetz-Einrichten
    if ($heimnetzGewuenscht -and -not $heimnetzBereit) { Firewall-Entfernen }
    Speicher-Anbieten

    # -- 3. Instanz -------------------------------------------------------------
    if (-not (Instanz-Vorhanden)) {
        $ort = Join-Path $env:USERPROFILE "wsl\$Instanz"
        Info "Lege die WSL-Instanz $Instanz an (Debian) ..."
        $rc = Wsl --install Debian --name $Instanz --location $ort --no-launch --web-download
        if ($rc -ne 0 -or -not (Instanz-Vorhanden)) { Abbruch "WSL-Instanz konnte nicht angelegt werden (wsl $rc)." }
        Ok "Instanz $Instanz angelegt ($ort)."
    }

    # systemd betreibt Docker. WSL-Interop ist fuer den Betrieb nicht erforderlich.
    Instanz-Konfigurieren
    Wachhalten-Einrichten
    Info 'Bereite die Linux-Instanz vor (bis zu zwei Minuten ohne weitere Ausgabe) ...'
    $rc = Wsl-Bash @'
set -e
timeout 90 systemctl is-system-running --wait >/dev/null 2>&1 || true
command -v curl >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates; }
'@
    if ($rc -ne 0) { Abbruch "Vorbereitung der Instanz fehlgeschlagen ($rc)." }
    Ok 'Instanz vorbereitet.'

    # -- 5. Ports ---------------------------------------------------------------
    # Ausdruecklich gewaehlte Ports muessen frei sein. Ohne Schalter bekommt nur
    # eine Erstinstallation fuer belegte Standardports freie Ersatzports; bei
    # einer bestehenden Installation wuerden Port-Schalter umstellen.
    $vorhanden = Installation-Vorhanden
    $schalter = @{}
    if ($WebPort)   { Port-Pruefen $WebPort 'WebPort';     $schalter['web-port'] = $WebPort }
    if ($HttpPort)  { Port-Pruefen $HttpPort 'HttpPort';   $schalter['http-port'] = $HttpPort }
    if ($HttpsPort) { Port-Pruefen $HttpsPort 'HttpsPort'; $schalter['https-port'] = $HttpsPort }
    if (-not $vorhanden) {
        $vergeben = @(@($WebPort, $HttpPort, $HttpsPort) | Where-Object { $_ })
        foreach ($e in @(@('https-port', 443, 8443), @('http-port', 80, 8080), @('web-port', 3420, 3421))) {
            if ($schalter.ContainsKey($e[0])) { continue }
            if ((Port-Belegt $e[1]) -or ($vergeben -contains $e[1])) {
                $p = Freier-Port $e[2] $vergeben
                Hinweis "Port $($e[1]) ist unter Windows belegt; postbuch.net nimmt stattdessen $p."
                $schalter[$e[0]] = $p
                $vergeben += $p
            } else {
                $vergeben += $e[1]
            }
        }
    }
    foreach ($k in $schalter.Keys) { $opt = ("$opt --$k=" + $schalter[$k]).Trim() }

    # -- 6. install.sh in der Instanz ------------------------------------------
    Write-Host ""
    Info 'Weiter geht es in der Linux-Instanz mit dem Einrichtungsdialog.'
    Write-Host ""
    $alterDokumentePfad = $env:POSTBUCH_WINDOWS_DOKUMENTE
    $alteWslEnv = $env:WSLENV
    try {
        $env:POSTBUCH_WINDOWS_DOKUMENTE = [Environment]::GetFolderPath('MyDocuments')
        $env:WSLENV = (@($alteWslEnv, 'POSTBUCH_WINDOWS_DOKUMENTE/u') | Where-Object { $_ }) -join ':'
        $rc = Wsl-Terminal (Installer-Befehl $opt)
    } finally {
        $env:POSTBUCH_WINDOWS_DOKUMENTE = $alterDokumentePfad
        $env:WSLENV = $alteWslEnv
    }
    if ($rc -ne 0) { Abbruch "Die Einrichtung in der Instanz ist nicht abgeschlossen (install.sh $rc). Derselbe Befehl setzt sie fort." }

    # -- 7. Firewall, Verknuepfung, Programme und Features ----------------------
    # Nach jedem Lauf neu, denn ueber das Menue koennen sich Ports geaendert haben.
    if (-not (Installation-Vorhanden)) {
        # Im Menue deinstalliert: Windows-Teil gleich mit aufraeumen.
        Write-Host ""
        Hinweis 'In der Instanz ist postbuch.net nicht mehr eingerichtet.'
        Info    'Vollstaendig entfernen: denselben Befehl mit -Deinstallieren ausfuehren.'
        Write-Host ""
        return
    }
    $ports = Instanz-Ports
    if ($heimnetzGewuenscht -and $heimnetzBereit) {
        try { Firewall-Setzen $ports } catch { Hinweis "Firewall-Freigabe fehlgeschlagen: $($_.Exception.Message)" }
    }
    $ico = Symbol-Anlegen $ports
    # Jeder Teil fuer sich: Scheitert die Desktop-Verknuepfung (etwa weil der
    # Ueberwachte Ordnerzugriff den Desktop sperrt), muss der Eintrag in
    # Programme und Features trotzdem entstehen.
    try { Verwaltung-Eintragen $ports $ico } catch { Hinweis "Eintrag in Programme und Features fehlgeschlagen: $($_.Exception.Message)" }
    Firewall-Status-Schreiben
    try { Verknuepfung-Setzen $ports } catch {
        Hinweis "Desktop-Verknuepfung nicht angelegt: $($_.Exception.Message)"
        Info    "postbuch.net ist trotzdem erreichbar: http://localhost:$($ports.Web)"
    }
    if ((Standby-Minuten) -gt 0) {
        Write-Host ""
        Hinweis 'Dieser PC geht am Netzteil nach einiger Zeit in den Energiesparmodus.'
        Info    'Solange er schlaeft, ist postbuch.net nicht erreichbar und die Verarbeitung pausiert.'
        Info    'Einstellen unter: Einstellungen > System > Netzbetrieb und Energie > Bildschirm und Energiesparmodus.'
    }
    $start = "http://localhost:$($ports.Web)/"
    Write-Host ""
    if (Restore-Offen) {
        $start = "http://localhost:$($ports.Web)/setup/restore"
        Hinweis 'Die Sicherung ist noch nicht eingespielt.'
        Info    "Das geschieht im Browser: $start"
        Info    'Bis dahin fuehrt auch die Desktop-Verknuepfung auf diese Seite.'
    } else {
        Ok "Fertig. postbuch.net: $start"
    }
    Write-Host ""
    # Im Standardbrowser oeffnen; scheitert das, steht die Adresse oben.
    try { Start-Process $start } catch { }
}

Write-Host ""
Write-Host "  postbuch.net fuer Windows" -ForegroundColor Cyan
Write-Host ""
# wsl.exe schreibt seine Meldungen sonst als UTF-16, Linux-Programme als UTF-8;
# die Konsole liest beides in der OEM-Codepage (Umlaute werden zu fremden Zeichen). Mit
# WSL_UTF8 kommt alles als UTF-8, und die Konsole liest UTF-8. Beides gilt nur
# fuer diesen Lauf und wird am Ende zurueckgesetzt.
$alteKodierung = [Console]::OutputEncoding
$altesWslUtf8 = $env:WSL_UTF8
try {
    $env:WSL_UTF8 = '1'
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
} catch { }
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Abbruch 'Bitte PowerShell mit "Als Administrator ausfuehren" starten und den Befehl erneut eingeben.'
    }
    if ($InstallerUrl -notmatch '^https://[A-Za-z0-9./_~%:-]+$') { Abbruch 'Ungueltige Installer-Adresse.' }
    if ($Zielversion -and -not $ZielversionOk) { Abbruch 'Ungueltige Zielversion (Form x.y.z).' }
    if ($Deinstallieren -and $Netzwerkfreigabe) { Abbruch 'Bitte Deinstallation und Netzwerkfreigabe getrennt aufrufen.' }
    if ($Netzwerkfreigabe -and ($WebPort -or $HttpPort -or $HttpsPort)) { Abbruch 'Bitte Portaenderungen getrennt aufrufen.' }
    if ($Deinstallieren) { Deinstallation }
    elseif ($Netzwerkfreigabe) { Netzwerkfreigabe-Aendern $Netzwerkfreigabe }
    else { Installation }
    $global:LASTEXITCODE = 0
} catch {
    $global:LASTEXITCODE = 1
    $m = $_.Exception.Message
    if ($m.StartsWith($Abbruchmarke)) { $m = $m.Substring($Abbruchmarke.Length) } else { $m = "Unerwarteter Fehler: $m" }
    Write-Host ""
    Write-Host "  [x] $m" -ForegroundColor Red
    Write-Host ""
} finally {
    Konsole-Zuruecksetzen
    try { [Console]::OutputEncoding = $alteKodierung } catch { }
    $env:WSL_UTF8 = $altesWslUtf8
}
}

# Als Datei aufgerufen (powershell -File install.ps1) endet das Skript mit dem
# Ergebnis: 0 fertig, 1 abgebrochen. Per iex oder Scriptblock laeuft es in der
# Sitzung des Nutzers, $PSCommandPath ist dann leer, und es gibt kein exit.
if ($PSCommandPath) { exit $global:LASTEXITCODE }
