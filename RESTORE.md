# Herstel en herbouw

Deze repository bevat de projectbron, manifesten, afbeeldingen, vertalingen en
functionele documentatie. Zie README.md voor het doel en de werking.

## Vereisten en lokale build

Installeer Node.js en npm plus de Homey CLI. De herstelcontrole op 2026-10-02
gebruikte Node.js 25.9.0, npm 11.12.1 en Homey CLI 4.4.1 op macOS.

```sh
npm install --global homey@4.4.1
git clone https://github.com/RyGe87/homey-tvremote.git
cd homey-tvremote
npm ci --ignore-scripts --no-audit --no-fund
homey app build
homey app validate
```

Een build en validatie werken lokaal zonder verbinding met een Homey.
Het door de CLI aangemaakte `.homeybuild/` is opnieuw aanmaakbaar.
De JavaScript-dependencies worden met de meegeleverde package-lock.json geïnstalleerd.

## Installatie en configuratie

Voor installatie op een Homey Pro, vanuit de projectmap:

```sh
homey login
homey app install
```

Na installatie: stel het vaste lokale IP-adres van de Android TV in en doorloop de pairing met de code op het TV-scherm. De app maakt zelf een certificaat en sleutel en bewaart die met de pairing in Homey-instellingen. Deze privésleutel hoort niet in GitHub. De .homeycompose/-bestanden, driver.compose.json, widget.compose.json, widgetbronnen en beide .proto-bestanden zijn nodig en zitten in de repo. Homey firmware >=12.3 is vereist.

## Wat buiten deze projectmap staat

De broncode volstaat om de app opnieuw te bouwen. Een volledige reconstructie
van een bestaande Homey-installatie vereist daarnaast een Homey-back-up of het
opnieuw instellen van devices, instellingen, pairings en flows. Die gegevens zijn
niet aanwezig in deze lokale ontwikkelmap en worden niet door GitHub geback-upt.
Het verwijderen van de ontwikkelmap wijzigt de geïnstalleerde app op Homey niet.

`node_modules/`, `.homeybuild/` en Finder-metadata zijn opnieuw aanmaakbaar en
worden niet meegeversioneerd. Eventuele `.serena/`-bestanden zijn lokale editor-
/toolinstellingen en zijn niet nodig voor de app of de build. Bewaar wachtwoorden,
API-sleutels en pairing-privésleutels buiten de repository.

