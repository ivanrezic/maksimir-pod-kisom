# Maksimir pod kišom

Današnji stadion Maksimir i pobjednik arhitektonskog natječaja iz 2026. u 3D, jedan uz drugi na svojim parcelama uz Park Maksimir. Za odabrani vjetar i kišu stranica pokazuje koliko gledatelja pokisne, koliko puše na sjedalima i puše li kroz otvorene kutove novog stadiona.

**Stranica:** https://ivanrezic.github.io/maksimir-pod-kisom/

## Kako radi

- Vjetar oko svakog stadiona računa 3D simulacija strujanja zraka na grafičkoj kartici (Lattice-Boltzmann D3Q19 sa Smagorinskyjevim modelom turbulencije, ćelije od 5 m). Preglednik bez podrške za float teksture dobiva jednostavniju procjenu praćenjem zraka.
- Kapi kiše prate se unatrag od glave svakog gledatelja kroz simulirano polje, a brzina padanja ovisi o jačini kiše.
- Okolne zgrade i park nisu u simulaciji. Model je grub i služi za usporedbu, ne za projektiranje.

## Izrada

Sve je u jednoj HTML datoteci, bez ovisnosti osim three.js s CDN-a.

```sh
python3 tools/build.py      # src/ -> dist/index.html
python3 -m http.server -d dist
```

`tools/extract_env.py` iz sirovih OpenStreetMap podataka (`tools/osm_*.json`) radi `src/env.json` s parkom, cestama i zgradama.

Svaki push na `main` objavljuje stranicu kroz GitHub Pages (`.github/workflows/pages.yml`).

## Izvori

- Okolina i tlocrti današnjih tribina: © suradnici [OpenStreetMapa](https://www.openstreetmap.org/copyright), ODbL.
- Novi stadion prema [plakatima prve nagrade](https://stadion-maksimir.zagreb.hr/hr/rezultati-natjecaja-128/128), današnji prema [modelu Genius & Gerry](https://geniusandgerry.com/products/stadion-maksimir-zagreb-croatia-3d-model) i fotografijama.

## Licenca

Kod je pod [MIT licencom](LICENSE): slobodno ga koristi, mijenjaj i objavljuj, samo zadrži obavijest o autorskim pravima. Podaci iz OpenStreetMapa (`tools/osm_*.json`, `src/env.json`) ostaju pod licencom [ODbL](https://opendatacommons.org/licenses/odbl/).

Prijedlozi i ispravci su dobrodošli kao PR.
