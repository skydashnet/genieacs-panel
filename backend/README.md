# TR69 Controle Backend

API Express 5 yang juga menyajikan hasil static export frontend. Database default adalah SQLite di `DATA_DIR`; MySQL dapat dipilih dan dimigrasikan saat runtime melalui halaman Settings.

## Menjalankan

Butuh Node.js 22.22 atau lebih baru.

```bash
npm ci
cp .env.example .env
npm run dev
```

Untuk production, isi `JWT_SECRET` yang acak dan kuat, set `APP_ENV=production`, lalu jalankan:

```bash
npm ci --omit=dev
npm start
```

Server default menggunakan port `5890`. Setup akun admin pertama dilakukan dari UI dan dilindungi transaksi database agar hanya satu akun awal yang dapat dibuat.

## Pemeriksaan

```bash
npm run check
npm audit
```

Pemeriksaan lokal memvalidasi syntax entrypoint, service GenieACS, service SGP, controller perangkat, controller SGP, dan controller portal pelanggan. Build frontend, lint, typecheck, serta audit dependency dijalankan dari root project sebelum release.

Konfigurasi environment dijelaskan di [`.env.example`](.env.example). URL GenieACS dan database runtime dikelola dari UI.

## Integrasi SGP

Kredensial SGP (URL, app, token) dikelola dari Settings > SGP integration dan disimpan terenkripsi di tabel `app_state`, bukan di environment. Lihat [`docs/sgp-integration.md`](../docs/sgp-integration.md).
