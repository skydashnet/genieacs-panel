# GenieACS Panel

Panel manajemen perangkat jaringan di atas GenieACS. Berjalan sebagai satu layanan (UI + API dalam satu port) dengan SQLite bawaan, jadi bisa langsung jalan tanpa database eksternal.

## Fitur

- Satu layanan, satu port (default `5890`), SQLite bawaan.
- Setup wizard: akun admin pertama dibuat lewat browser saat pertama dibuka.
- Ganti ke MySQL kapan saja lewat Settings, tanpa edit konfigurasi manual.
- Dashboard monitoring, manajemen ONT/ODP/ODC, peta jaringan, konfigurasi multi-vendor, dan keamanan WiFi.
- Autentikasi JWT dengan refresh token dan role-based access control.

## Instalasi

Server Linux dengan `systemd`. Installer mendukung Debian/Ubuntu, Fedora/RHEL/Rocky/Alma,
Arch Linux, dan openSUSE. Git, tool build, serta Node.js 22 akan dipasang otomatis bila
belum tersedia. Node.js 20 atau lebih baru yang sudah ada akan digunakan.

```bash
# Dari user biasa:
curl -fsSL https://raw.githubusercontent.com/skydashnet/genieacs-panel/main/deploy/install.sh | sudo bash

# Jika sudah login sebagai root, tanpa sudo:
curl -fsSL https://raw.githubusercontent.com/skydashnet/genieacs-panel/main/deploy/install.sh | bash
```

Buka `http://localhost:5890` untuk setup admin. Panel default terikat ke `127.0.0.1`; jalankan `skygenpanel expose` bila perlu diakses dari jaringan.

## CLI `skygenpanel`

| Perintah | Keterangan |
| --- | --- |
| `update` | Ambil kode terbaru, build ulang, restart |
| `expose` / `unexpose` | Buka ke jaringan (`0.0.0.0`) / batasi ke localhost |
| `restart` / `start` / `stop` / `status` | Kontrol layanan |
| `logs [N]` | Ikuti `N` baris log terakhir (default 100) |
| `reset-password <user> [pass]` | Reset password user; tanpa argumen password akan diminta secara tersembunyi |

## Pengembangan

```bash
git clone https://github.com/skydashnet/genieacs-panel
cd genieacs-panel
npm run install:all
npm run dev:backend    # API + UI di http://localhost:5890
npm run dev:frontend   # Next.js dev server (proxy /api ke backend)
```

Build produksi lokal: `npm run build` lalu `npm start`.

## Konfigurasi

Konfigurasi environment ada di `backend/.env` (lihat `backend/.env.example`): `APP_PORT`, `APP_HOST`, `JWT_SECRET`, `CORS_ORIGINS`, dan `DATA_DIR` opsional.

URL GenieACS dan database MySQL **tidak** diatur lewat `.env`, melainkan lewat halaman Settings di antarmuka. Konfigurasi database tersimpan di `DATA_DIR/db-config.json`.

## Ganti Database

Lewat **Settings → Database** (admin): lihat konfigurasi aktif, uji koneksi MySQL, lalu pindah dengan opsi migrasi data. Perpindahan berlangsung runtime.

## Arsitektur

- Backend: Node.js + Express 5, Knex dual-dialect (SQLite via better-sqlite3, MySQL via mysql2), JWT. Menyajikan API sekaligus frontend statis dengan SPA fallback.
- Frontend: Next.js 15 (App Router, static export), TypeScript, Tailwind CSS.

## Keamanan

- JWT dengan refresh token, role-based access control, password hashing bcrypt.
- Default terikat ke `127.0.0.1`; akses jaringan opt-in via `skygenpanel expose`.
- systemd unit di-harden (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths` terbatas).

## Docker

```bash
docker build -t genieacs-panel .
docker run -p 5890:5890 -v skygp-data:/var/lib/skygenpanel \
  -e DATA_DIR=/var/lib/skygenpanel \
  -e JWT_SECRET="$(openssl rand -hex 48)" \
  genieacs-panel
```

Simpan nilai `JWT_SECRET` dan gunakan nilai yang sama setiap container dibuat ulang agar sesi pengguna tidak terputus.

## Lisensi

MIT License. Lihat [LICENSE](LICENSE) untuk detail.

Dukungan: support@skydash.net · [GitHub Issues](https://github.com/skydashnet/genieacs-panel/issues)

---

© 2024 SkydashNET.
