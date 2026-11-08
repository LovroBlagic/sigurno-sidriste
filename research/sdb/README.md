# Satelitska batimetrija (SDB) oko Plavnika: istraživački prototip

**Zaključak: ne prikazivati nautičarima.** Na Plavniku nema dovoljno pravih mjerenja dubine
za kalibraciju i provjeru. Dubina koju procijenimo sa satelita nije provjerena i nema
dokazanu točnost. Ovaj eksperiment ne dira aplikaciju (`web/`, `server/`, `api/`).

![SDB Plavnik](sdb_plavnik.png)

## Metoda

1. **Snimka:** Sentinel-2 L2A, kanali B02 (plavi), B03 (zeleni) i B08 (NIR), 10 m.
   Uzeta je s javnog Element84 Earth Search STAC-a (bucket `sentinel-cogs` na AWS-u, bez prijave).
   Od 42 snimke s manje od 3 % oblaka (05/2025–11/2026) izabrane su dvije s najmanje odsjaja
   (glinta) nad dubokom vodom:
   - glavna: `S2B_33TVK_20260916_0_L2A`;
   - kontrolna: `S2A_33TVK_20250918_1_L2A`.

   Pazi na skaliranje: Earth Search je već skinuo L2A pomak (`earthsearch:boa_offset_applied`),
   pa je refleksija = DN·1e-4. Ako se primijeni i `offset: -0.1` iz STAC-a, voda ispadne negativna.
2. **Maska kopna:** piksel je kopno ako je B08 > 0.02. Prvi vodeni piksel uz obalu se odbacuje
   (miješani pikseli, utjecaj susjednog kopna). NDWI se pokazao nestabilnim nad tamnom vodom,
   pa se ne koristi.
3. **Stumpfov omjer:** `ln(1000·B02) / ln(1000·B03)`, zatim medijan na 5×5 piksela (50 m)
   protiv šuma i pruga senzora.
4. **Referentne dubine:** EMODnet DTM 2024, preko WCS-a. Za svaku ćeliju dubine 0–20 m
   izvor se dohvaća preko REST-a (`depth_sample` → `reference.identifier`). WFS sloj
   `source_references` se u provjeri na 60 ćelija nije slagao s REST-om pa se ne koristi.
   - `Pula_Rijeka_Cres_Dubrovnik`: Hrvatski hidrografski institut (HHI), multibeam i singlebeam
     premjeri 1951–2017, DTM 225 m, LAT. **Jedini pravi premjer, samo on se koristi za kalibraciju.**
   - `croatia2003`: **nije premjer.** Prema metapodacima to je EOMAP-ova satelitska batimetrija
     iz Sentinel-2 (2019). Kalibracija na njoj bila bi kružna, pa služi samo kao usporedba.
   - `GEBCO2024`: globalna interpolacija, neupotrebljiva.
5. **Model:** linearni pravac omjer → dubina, po ćelijama EMODneta (~115 × 80 m). Za ćeliju se
   uzima medijan omjera, i to samo ako je barem 90 % njezinih piksela voda.
   - Provjera na izdvojenim točkama: slučajnih 30 % te prostorna podjela zapad/istok.
   - Granica optički duboke vode: 10. percentil omjera u ćelijama dubljim od 50 m.
     Dublje od toga satelit ne razlikuje dno od otvorenog mora i karta je prazna.

## Rezultati

Ćelije dubine 0–20 m u okviru 14.42–14.62 E, 44.91–45.03 N, za snimku 2026-09-16:

| izvor (REST) | broj ćelija |
|---|---|
| GEBCO2024 | 2405 |
| croatia2003 (EOMAP SDB) | 724 |
| bez izvora | 110 |
| **HHI premjer** | **54** |

HHI ćelije su gotovo sve na 15–20 m (10. percentil 14.7 m, medijan 17.7 m). Samo dvije su
pliće od 13 m. Njih 49 od 54 je već iza optičke granice.

| | 2026-09-16 | 2025-09-18 |
|---|---|---|
| HHI ćelija za kalibraciju | 54 | 55 |
| Pearson r (omjer vs. HHI dubina) | 0.04 | 0.10 |
| **izdvojenih 30 %: RMSE / bias / R²** | **2.0 m / −0.6 m / −0.08** (n=16) | **2.1 m / −0.4 m / −0.25** (n=16) |
| prostorno zapad→istok, istok→zapad: RMSE | 3.3 m, 2.6 m (R² < 0) | 3.8 m, 2.7 m (R² < 0) |
| omjer vs. EOMAP SDB: Pearson r (n) | 0.64 (724) | 0.75 (735) |
| kalibrirano na EOMAP-u, provjereno na HHI: RMSE / bias / R² | 4.1 m / +1.9 m / −1.07 | 4.7 m / +2.5 m / −1.30 |
| najveća razlučiva dubina (EOMAP skala) | ≈ 16 m | ≈ 16 m |

Kako čitati brojke:

- **Kalibracija na premjeru nema nikakvu moć.** RMSE od 2 m izgleda dobro samo zato što su sve
  točke na 15–20 m, a model vraća konstantu od oko 17 m. R² ≤ 0 znači da model nije bolji od prosjeka.
- **Signal u omjeru postoji.** Omjer raste s dubinom: 0–5 m ≈ 0.95, 15–20 m ≈ 1.60,
  duboko more ≈ 1.72. Sa EOMAP-om se slaže s r ≈ 0.65–0.75. Na karti se vidi pojas plićaka
  širok 50–150 m uz južnu i istočnu obalu Plavnika i oko otočića na JI.
  No slaganje dvaju satelitskih proizvoda nije točnost.
- **Koeficijenti ovise o snimci.** Nagib je 9.6 na jednoj, a 16.9 na drugoj snimci. Svaka snimka
  zato traži vlastitu kalibraciju na pravim mjerenjima.
- **Karta (lijevo) je samo relativni oblik.** Kalibrirana je na EOMAP-u, a ne na premjeru.
  Plave mrlje na otvorenom moru (12–16 m) su šum i ostaci odsjaja. Pravokutnici sjeverno od
  Plavnika vjerojatno su uzgajališta (kavezi ili plutače), a ne dno.

## Ograničenja

- **Tamno dno** (posidonija, alge, tamna stijena) daje premalo zelenog svjetla, pa se čita kao
  dublje nego što jest. To je opasno upravo za sidrenje, jer posidonija i pliće dno idu zajedno.
- **Glint, valovi i brodski tragovi** remete omjer. Medijan na 5×5 piksela to samo ublažava.
- **Mutnoća** (kiša, bujice, cvjetanje planktona) mijenja omjer neovisno o dubini.
  Zato vrijedi ono gore: svaka snimka svoja kalibracija.
- **Optička granica je oko 16 m** u ovoj vodi. Dublje se ne može ništa reći, a 15–20 m je upravo
  raspon u kojem leži većina premjera.
- **Prostorna nepodudarnost:** 10 m pikseli se uspoređuju s DTM-om od 225 m, preuzorkovanim na
  115 m. Uz strmu obalu jedna ćelija pokriva i 3 m i 25 m dubine.
- **Visinski datum:** HHI je u LAT-u, a satelit vidi trenutnu razinu mora. Plima na Kvarneru
  je oko 0.3–0.5 m i nije korigirana, što je malo u odnosu na ostale pogreške.

## Što bi trebalo da SDB postane upotrebljiv

1. **Prava plitka mjerenja oko Plavnika**, na primjer zapis dubinomjera s plotera tijekom jedne
   plovidbe uz obalu. To je najjeftinija i najvrjednija opcija. Druga mogućnost su HHI sondaže
   s karata ili ENC, ali za njih treba licenca.
2. **ICESat-2 ATL03** (NASA, besplatno): laserske fotonske dubine do oko 20–30 m u bistroj vodi.
   Standardni su izvor kalibracije za SDB tamo gdje premjera nema.
3. Kompozit više snimaka (medijan) i maska vegetacije (posidonije) prije regresije.

Dok točnost na neovisnim mjerenjima ne bude ispod oko 1 m na 0–10 m, SDB nema mjesto u aplikaciji
za nautičare. Najviše bi mogao poslužiti kao kvalitativni sloj „ovdje je vjerojatno plićak, provjeri”.

## Pokretanje

```bash
python3 -m venv .venv-sdb && .venv-sdb/bin/pip install numpy rasterio matplotlib
.venv-sdb/bin/python research/sdb/sdb_plavnik.py            # obje snimke
.venv-sdb/bin/python research/sdb/sdb_plavnik.py S2B_33TVK_20260916_0_L2A
```

Prvo pokretanje traje oko 10 minuta: skida izreze snimaka (~25 MB) i pita EMODnet REST za izvor
~3500 ćelija, sekvencijalno, da ne udari u 429. Sve se sprema u `research/sdb/data/`, što git
ignorira. Izlazi su `sdb_plavnik.png` (prva snimka) i `results.json` (obje snimke).

## Izvori podataka i licence

- **Sentinel-2 L2A:** sadrži izmijenjene podatke Copernicus Sentinel [2025, 2026]
  (ESA/EU Copernicus, slobodna i otvorena licenca). Dohvaćeno preko Element84 Earth Search /
  AWS Open Data `sentinel-cogs`.
- **EMODnet Bathymetry DTM 2024:** EMODnet Bathymetry Consortium, CC BY 4.0. Uključuje premjere
  Hrvatskog hidrografskog instituta (oznaka *Not for Navigation*), EOMAP SDB `croatia2003`
  i GEBCO 2024 kao popunu (GEBCO Compilation Group, javno dostupno).
- **Metoda:** Stumpf, Holderied & Sinclair (2003), *Limnology and Oceanography* 48(1):547–556.
