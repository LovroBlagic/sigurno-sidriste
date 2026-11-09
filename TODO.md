# TODO - eSidro

Rok predaje: **ponedjeljak 9. 11. 2026. u 24:00**, isključivo e-poštom na **open.data@mpudt.hr**.
Rješenje bez videa se ne ocjenjuje (Pravila, pogl. VIII).

## 1. Obavezno za predaju

- [ ] **Video prezentacija do 3 minute** (bez nje nema ocjenjivanja). Mora obuhvatiti:
  - [ ] problem (posidonija, neiskusni nautičari, nagli vjetar)
  - [ ] ciljane korisnike
  - [ ] korištene izvore podataka, posebno tri skupa s data.gov.hr
  - [ ] demonstraciju u primjeni: pretraga, detalji mjesta, posidonija, Moj brod, loše vrijeme (`?sim=bura`), zaštićeno područje, Plovputova oznaka opasnosti
  - [ ] AI asistent preko MCP-a
  - [ ] tehničku arhitekturu (dijagram iz `docs/ARHITEKTURA.md`)
  - [ ] korisničku vrijednost
  - [ ] mogućnosti daljnjeg razvoja (vidi odjeljak 4)
  - [ ] naraciju snima član tima (pravi glas umjesto sintetskog)
  - [ ] video staviti na poveznicu koja radi barem do 17. 11. (npr. YouTube kao „unlisted“ ili Google Drive)
- [ ] **Snimke zaslona** (demo materijali): popis sidrišta, detalji mjesta, posidonija, loše vrijeme, Moj brod, mobitel
- [ ] **E-mail predaje** sadrži:
  - [ ] naziv tima, izazov **B) Okoliš i održivi prostor**, članove i mentora
  - [ ] javni repozitorij: https://github.com/LovroBlagic/sigurno-sidriste
  - [ ] radni prototip: https://sigurno-sidriste.vercel.app (simulacija bure: `/?sim=bura#f=43.1680,16.3700`)
  - [ ] MCP poslužitelj: https://sigurno-sidriste.vercel.app/mcp
  - [ ] dokumentaciju: `README.md`, `docs/ARHITEKTURA.md` (arhitektura, popis skupova podataka s izvorima, preduvjeti), `web/openapi.json`
  - [ ] poveznicu na video i snimke zaslona
- [ ] Dogovoriti s mentorom tko šalje predaju (prema Pravilima mentor je voditelj tima i komunicira s organizatorom)

## 2. Provjere prije slanja

- [ ] Svi članovi i mentor ispunili su prijavni obrazac (rok je bio 30. 10.)
- [ ] Privola za javnu objavu videa dana je u prijavnom obrascu (ako se netko pojavljuje ili ga se čuje)
- [ ] Izjava o korištenju AI alata u `README.md` i `docs/ARHITEKTURA.md` točno opisuje udio tima
- [ ] Aplikacija radi na mobitelu i računalu neposredno prije slanja (prva pretraga zna trajati 10-15 s)
- [ ] Sve poveznice u e-mailu otvaraju se bez prijave
- [ ] Repozitorij je javan i ima licencu (MIT - gotovo)

## 3. Otvorena pitanja

- [ ] Licenca podataka s Bioportala (zaštićena područja, Natura 2000): na data.gov.hr nije navedena, servis navodi „nema ograničenja“. Po potrebi pitati open.data@mpudt.hr ili Ministarstvo zaštite okoliša i zelene tranzicije.
- [ ] Službena upozorenja DHMZ-a / Meteoalarm: provjeriti postoji li strojno čitljiv feed i pod kojom licencom (bio bi još jedan javni izvor)

## 4. Moguće funkcionalnosti (nakon predaje / plan razvoja)

- [ ] **Prijave korisnika** - „ovdje ima posidonije koju karta ne pokazuje“ i „netko sidri na posidoniji“; administratorski pregled za javne ustanove parkova (paziti na GDPR kod fotografija)
- [ ] **Rad bez interneta, 2. dio** - gumb „spremi područje“ za naše pločice dubine; nova pretraga bez mreže nije moguća (dubina i vjetar su uživo)
- [ ] **Službena upozorenja DHMZ-a** u načinu rada za loše vrijeme
- [ ] **Najbliža luka ili marina** kao zamjena kad nema zaklona
- [ ] **Zone sidrenja i polja plutača u parkovima** - uz podatke javnih ustanova
- [ ] **Službena batimetrija HHI-ja** umjesto EMODnet mreže (~115 m) za točniju dubinu uz obalu
- [ ] **Satelitsko otkrivanje sidrenja na posidoniji** - komercijalne snimke visoke rezolucije i model; za javne ustanove parkova
- [ ] **AIS / popunjenost uvala** - većina rekreacijskih plovila nema AIS, bolje iz prijava korisnika
- [ ] Testovi za `assess()` i `findSpots()`
- [ ] Zajednička predmemorija (npr. Redis) i zagrijavanje popularnih područja da prva pretraga bude brza
- [ ] Vlastiti geokoder ili komercijalni plan umjesto javnog Nominatima pri većem prometu

## Gotovo

- [x] Web aplikacija (pretraga, detalji, karta, mobilni prikaz) i MCP poslužitelj
- [x] Javni URL na Vercelu, automatska objava s `main`
- [x] Dokumentacija: arhitektura, izvori s poveznicama i licencama, preduvjeti, integracija, OpenAPI
- [x] Tri skupa podataka s data.gov.hr: zaštićena područja, Natura 2000, Plovputov registar objekata sigurnosti plovidbe
- [x] Moj brod (gaz, lanac, duljina) i položaj broda
- [x] Način rada za loše vrijeme (prognoza 24 h, upozorenje, samo zaklonjena mjesta, simulacija)
- [x] MIT licenca, popis tima, izjava o korištenju AI alata
- [x] Rad bez interneta: aplikacija se otvara bez signala, zadnja pretraga je spremljena, provjera dna i posidonije iz spremljenih slojeva; može se dodati na početni zaslon mobitela
