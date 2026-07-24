# SkyGenPanel Backend

API Express 5 yang juga menyajikan hasil static export frontend. Database default adalah SQLite di `DATA_DIR`; MySQL dapat dipilih dan dimigrasikan saat runtime melalui halaman Settings.

## Menjalankan

Butuh Node.js 20 atau lebih baru.

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
npm test
npm audit
```

Test suite mencakup autentikasi, CORS, error handling production, migrasi database dengan foreign key, normalisasi data perangkat, jalur WAN, serta script installer/init/reset-password.

Konfigurasi environment dijelaskan di [`.env.example`](.env.example). URL GenieACS dan database runtime dikelola dari UI.
