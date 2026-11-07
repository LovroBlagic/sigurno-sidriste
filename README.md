# Sigurno sidrište

Gdje sidriti na hrvatskom Jadranu. Upiši mjesto (npr. *Pakleni otoci*), pritisni **Pronađi sidrište u blizini** i dobiješ do 5 najboljih mjesta s dubinom, vrstom dna, zaklonom i duljinom lanca. Ili dodirni more na karti za provjeru jedne točke.

Isto znanje dostupno je i AI asistentima preko **MCP servera**, pa nautičar može samo pitati:
> *"Gdje mogu sidriti večeras kod Visa, puše jugo?"*

## Što se provjerava

| Provjera | Izvor | Kako se koristi |
|---|---|---|
| Koliko dno drži | EMODnet Geology 1:250k, rupe popunjene s 1:1M | pijesak odlično, mulj dobro, šljunak osrednje, stijene loše |
| Livade morske trave | EMODnet Seabed Habitats 2025 (UNEP-WCMC, HAOP) | kartirana posidonija / čvorasta morska resa → **ne sidri** |
| Moguća posidonija | EUSeaMap 2025 infralitoral + hrvatska Art. 17 mreža | upozorenje: spusti sidro na svijetli pijesak |
| Dubina | EMODnet Bathymetry (uživo) | 3–15 m idealno, >35 m preduboko |
| Zaklon | EMODnet profili dubine u 8 smjerova (uživo) | kopno unutar 1,5 km u smjeru najjačeg vjetra idućih 12 h |
| Vjetar, udari, valovi | Open-Meteo (uživo) | hrvatski nazivi vjetrova (bura, jugo, maestral…) |
| Zaštićena područja | Bioportal Natura 2000 (ptice) | informativno |
| Mjesta | OpenStreetMap Nominatim | "Hvar" → koordinate |

Pomoć pri planiranju, ne navigacijska karta.

## Pokretanje

```bash
npm install
npm run data     # jednom: preuzmi i pripremi slojeve (Python 3 + Node)
npm start        # http://localhost:5173  ·  MCP: http://localhost:5173/mcp
```

## MCP

Dva alata: `pronadi_sidriste` (mjesto ili lat/lon, polumjer) i `provjeri_tocku` (mjesto ili lat/lon).

**Claude Code** - već je podešeno u `.mcp.json`, samo otvori projekt.

**Claude Desktop** - dodaj u `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sigurno-sidriste": {
      "command": "node",
      "args": ["/PUNA/PUTANJA/DO/OKOLIS/mcp/stdio.js"]
    }
  }
}
```

**Udaljeno (ChatGPT, Claude.ai konektori)** - kad se server objavi na javni URL, dodaj `https://<domena>/mcp` kao prilagođeni konektor.

## Struktura

- `web/core.js` - sva logika (ocjena, pretraga, zaklon, geokodiranje), dijele je web i MCP
- `web/index.html`, `web/app.js`, `web/style.css` - sučelje (Leaflet)
- `server/index.js` - jedan Node server: web + `/api/*` + `/mcp`; ograničava i pamti pozive prema EMODnetu
- `mcp/tools.js` - definicije MCP alata · `mcp/stdio.js` - stdio ulaz
- `scripts/download_data.py`, `scripts/build_layers.py` - priprema podataka (22 MB → ~1,3 MB)
