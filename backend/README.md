# GenieACS Panel Backend API

Backend API untuk GenieACS Panel yang telah direstrukturisasi dengan arsitektur professional dan dipindahkan dari SQLite ke MariaDB.

## Struktur Proyek

```
Backend/
├── src/
│   ├── config/
│   │   └── database.js
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── deviceController.js
│   │   ├── settingsController.js
│   │   ├── vendorController.js
│   │   ├── mappingController.js
│   │   └── mapSettingsController.js
│   ├── middleware/
│   │   └── auth.js
│   ├── models/
│   │   ├── User.js
│   │   ├── Setting.js
│   │   ├── Vendor.js
│   │   ├── MapSettings.js
│   │   ├── MappingNode.js
│   │   ├── MappingEdge.js
│   │   └── WifiSecurityConfig.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── devices.js
│   │   ├── settings.js
│   │   ├── vendors.js
│   │   ├── mapping.js
│   │   └── mapSettings.js
│   ├── services/
│   │   ├── deviceService.js
│   │   └── vendorService.js
│   ├── utils/
│   │   └── helpers.js
│   └── server.js
├── .env.example
├── .gitignore
├── Dockerfile
├── package.json
└── README.md
```

## Fitur

- **Autentikasi JWT** dengan refresh token
- **Manajemen Perangkat** dengan deteksi vendor otomatis
- **Manajemen Pengaturan** sistem
- **Manajemen Pemetaan Jaringan** dengan nodes dan edges
- **Konfigurasi WiFi Security** per vendor dan product class
- **API RESTful** untuk semua operasi CRUD
- **Migrasi Database** dari SQLite ke MariaDB
- **Docker Support** untuk deployment mudah

## Database

- **MariaDB** dengan connection pooling
- **Migrasi Otomatis** dengan script `migrate_db.js`
- **Environment Variables** untuk konfigurasi yang aman

## API Endpoints

### Autentikasi
- `POST /api/auth/login` - Login user
- `POST /api/auth/refresh` - Refresh token
- `GET /api/auth/user` - Get current user
- `POST /api/auth/logout` - Logout
- `POST /api/auth/change-password` - Ubah password
- `POST /api/auth/change-username` - Ubah username

### Perangkat
- `GET /api/devices` - Get semua perangkat
- `GET /api/devices/:deviceId` - Get detail perangkat
- `POST /api/devices/reboot` - Reboot perangkat
- `POST /api/devices/summon` - Summon parameter perangkat
- `DELETE /api/devices/:deviceId` - Hapus perangkat

### Pengaturan
- `GET /api/settings` - Get semua pengaturan
- `GET /api/settings/:key` - Get pengaturan spesifik
- `POST /api/settings` - Buat pengaturan baru
- `PUT /api/settings/:key` - Update pengaturan
- `DELETE /api/settings/:key` - Hapus pengaturan
- `POST /api/settings/test-genieacs` - Test koneksi GenieACS

### Vendor Management
- `GET /api/vendor-management/vendors` - Get semua vendor
- `GET /api/vendor-management/vendors/:id` - Get vendor berdasarkan ID
- `POST /api/vendor-management/vendors` - Buat vendor baru
- `PUT /api/vendor-management/vendors/:id` - Update vendor
- `DELETE /api/vendor-management/vendors/:id` - Hapus vendor

### Mapping Data
- `GET /api/mapping-data/nodes` - Get semua node
- `GET /api/mapping-data/nodes/:nodeId` - Get node berdasarkan ID
- `POST /api/mapping-data/nodes` - Buat node baru
- `PUT /api/mapping-data/nodes/:nodeId` - Update node
- `DELETE /api/mapping-data/nodes/:nodeId` - Hapus node
- `GET /api/mapping-data/edges` - Get semua edge
- `GET /api/mapping-data/edges/:edgeId` - Get edge berdasarkan ID
- `POST /api/mapping-data/edges` - Buat edge baru
- `PUT /api/mapping-data/edges/:edgeId` - Update edge
- `DELETE /api/mapping-data/edges/:edgeId` - Hapus edge
- `POST /api/mapping-data/sync` - Sinkronisasi data mapping
- `DELETE /api/mapping-data/reset` - Reset data mapping (dengan password admin)

### Map Settings
- `GET /api/map-settings` - Get pengaturan peta
- `PUT /api/map-settings` - Update pengaturan peta
- `POST /api/map-settings/reset` - Reset ke default

## Cara Menjalankan

### Development
```bash
cd Backend
npm install
npm run dev
```

### Production dengan Docker
```bash
cd Backend
docker build -t genieacs-panel-api .
docker run -p 3000:3000 -e DB_HOST=your_db_host -e DB_PASSWORD=your_db_password -e DB_NAME=your_db_name -e DB_USER=your_db_user genieacs-panel-api
```

## Environment Variables

Lihat file `.env.example` untuk variabel lingkungan yang dibutuhkan.