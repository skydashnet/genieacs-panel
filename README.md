# SkyGenPanel

Panel manajemen perangkat jaringan di atas GenieACS. Panel operator dan portal pelanggan berjalan dari satu service dengan SQLite bawaan, jadi bisa langsung jalan tanpa database eksternal.

## Fitur

- Satu service: panel operator pada port `5890` dan portal pelanggan terisolasi pada port `5891`.
- Setup wizard: akun admin pertama dibuat lewat browser saat pertama dibuka.
- Ganti ke MySQL kapan saja lewat Settings, tanpa edit konfigurasi manual.
- Dashboard monitoring, manajemen ONT/ODP/ODC, peta jaringan, konfigurasi multi-vendor, dan keamanan WiFi.
- Autentikasi JWT dengan refresh token dan role-based access control.
- ID Customer permanen yang dapat dibuat otomatis dari SoftwareVersion + PPPoE, serta portal mandiri tanpa menampilkan konfigurasi WAN.
- Pelanggan dapat mengganti nama dan password WiFi milik ONT-nya sendiri. Password terakhir yang dikirim lewat portal dapat dilihat kembali dan disimpan terenkripsi di database.

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

Buka `http://localhost:5890` untuk setup admin. Portal pelanggan tersedia di `http://localhost:5891` setelah Auto Generate ID Customer diaktifkan. Keduanya default terikat ke `127.0.0.1`; jalankan `skygenpanel expose` bila perlu diakses dari jaringan.

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
npm run dev:frontend   # Vite dev server (proxy /api ke backend)
```

Build produksi lokal: `npm run build` lalu `npm start`.

## Konfigurasi

Konfigurasi environment ada di `backend/.env` (lihat `backend/.env.example`): `APP_PORT`, `PORTAL_PORT`, `APP_HOST`, `JWT_SECRET`, `PORTAL_JWT_SECRET`, `CORS_ORIGINS`, dan `DATA_DIR` opsional.

URL GenieACS dan database MySQL **tidak** diatur lewat `.env`, melainkan lewat halaman Settings di antarmuka. Konfigurasi database tersimpan di `DATA_DIR/db-config.json`.

## Ganti Database

Lewat **Settings → Database** (admin): lihat konfigurasi aktif, uji koneksi MySQL, lalu pindah dengan opsi migrasi data. Perpindahan berlangsung runtime.

## Arsitektur

- Backend: Node.js + Express 5, Knex dual-dialect (SQLite via better-sqlite3, MySQL via mysql2), JWT. Panel dan portal memakai listener terpisah agar API admin tidak terekspos pada port pelanggan.
- Frontend: Vite, React Router, TypeScript, dan Tailwind CSS.

## Keamanan

- JWT dengan refresh token, role-based access control, password hashing bcrypt.
- Default terikat ke `127.0.0.1`; akses jaringan opt-in via `skygenpanel expose`.
- systemd unit di-harden (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths` terbatas).
- Security headers/CSP ketat, validasi same-origin, rate limit login dan mutasi WiFi, sesi pelanggan via cookie HttpOnly, serta revokasi sesi admin ketika password berubah atau logout.
- Target perubahan portal selalu diambil dari sesi pelanggan, bukan dari request browser. Password WiFi tersimpan memakai enkripsi terautentikasi AES-256-GCM dan tidak pernah dikirim dalam respons mutasi.

## Docker

```bash
docker build -t genieacs-panel .
docker run -p 5890:5890 -p 5891:5891 -v skygp-data:/var/lib/skygenpanel \
  -e DATA_DIR=/var/lib/skygenpanel \
  -e JWT_SECRET="$(openssl rand -hex 48)" \
  genieacs-panel
```

Simpan nilai `JWT_SECRET` dan gunakan nilai yang sama setiap container dibuat ulang agar sesi pengguna dan password WiFi terenkripsi tetap dapat dibuka.

## Lisensi

MIT License. Lihat [LICENSE](LICENSE) untuk detail.

Dukungan: support@skydash.net · [GitHub Issues](https://github.com/skydashnet/genieacs-panel/issues)

---

© 2024 SkydashNET.
