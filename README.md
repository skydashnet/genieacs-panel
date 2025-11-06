# GenieACS Panel

Sistem manajemen perangkat jaringan modern yang dibangun di atas GenieACS dengan antarmuka yang intuitif dan fitur-fitur canggih untuk monitoring dan konfigurasi perangkat jaringan fiber optic.

## 🌟 Fitur Utama

- **Dashboard Interaktif** - Monitoring real-time status perangkat jaringan dengan visualisasi data yang komprehensif
- **Manajemen Perangkat** - Kontrol penuh atas ONT, ODP, dan ODC dengan detail informasi lengkap
- **Peta Jaringan** - Visualisasi topologi jaringan dengan representasi geografis
- **Konfigurasi Vendor** - Dukungan multi-vendor dengan parameter khusus untuk setiap tipe perangkat
- **Keamanan WiFi** - Manajemen pengaturan keamanan WiFi untuk berbagai vendor
- **Autentikasi Modern** - Sistem login dengan JWT token dan manajemen sesi yang aman

## 🏗️ Arsitektur

Project ini menggunakan arsitektur client-server dengan:

### Backend
- **Node.js** dengan Express.js untuk API server
- **MySQL** sebagai database utama
- **JWT** untuk autentikasi dan autorisasi
- **RESTful API** untuk komunikasi dengan frontend

### Frontend
- **Next.js 14** dengan App Router
- **TypeScript** untuk type safety
- **Tailwind CSS** untuk styling modern
- **React Context** untuk state management

## 🚀 Quick Start

### Prasyarat
- Node.js 18+ 
- MySQL 8.0+
- npm atau yarn

### Instalasi

1. Clone repository ini
```bash
git clone https://github.com/skydashnet/server.git
cd server
```

2. Setup backend
```bash
cd backend
npm install
cp .env.example .env
# Edit .env dengan konfigurasi database Anda
npm run dev
```

3. Setup frontend
```bash
cd frontend
npm install
npm run dev
```

4. Aplikasi akan tersedia di:
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## 📁 Struktur Project

```
server/
├── backend/                 # API server
│   ├── src/
│   │   ├── config/         # Konfigurasi database
│   │   ├── controllers/    # Logic controllers
│   │   ├── middleware/     # Middleware autentikasi
│   │   ├── models/         # Data models
│   │   ├── routes/         # API routes
│   │   ├── services/       # Business logic
│   │   └── utils/          # Utility functions
│   └── package.json
├── frontend/               # Next.js application
│   ├── src/
│   │   ├── app/           # App Router pages
│   │   ├── components/    # Reusable components
│   │   ├── contexts/      # React contexts
│   │   ├── hooks/         # Custom hooks
│   │   ├── lib/           # Library functions
│   │   └── types/         # TypeScript types
│   └── package.json
├── Dockerfile             # Docker configuration
└── README.md
```

## 🔧 Konfigurasi

### Environment Variables (Backend)

```env
# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=genieacs_panel

# Application
APP_PORT=3001
APP_ENV=development

# JWT
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=1h
REFRESH_TOKEN_EXPIRES_IN=7d

# GenieACS
GENIEACS_URL=http://your-genieacs-server:7557
```

### Environment Variables (Frontend)

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
```

## 📊 API Documentation

### Authentication
- `POST /api/auth/login` - Login user
- `GET /api/auth/user` - Get current user
- `POST /api/auth/logout` - Logout user
- `POST /api/auth/refresh` - Refresh token

### Devices
- `GET /api/devices` - Get all devices
- `GET /api/devices/:id` - Get device details
- `DELETE /api/devices/:id` - Delete device
- `POST /api/devices/reboot` - Reboot device
- `POST /api/devices/summon` - Summon device parameters

### Vendors
- `GET /api/vendor-management` - Get all vendors
- `POST /api/vendor-management` - Create vendor
- `PUT /api/vendor-management/:id` - Update vendor
- `DELETE /api/vendor-management/:id` - Delete vendor

## 🌐 Peta Jaringan

Sistem peta jaringan menyediakan visualisasi topologi dengan:

- **Node Types**: Server, ODC (Optical Distribution Cabinet), ODP (Optical Distribution Point), ONT (Optical Network Terminal)
- **Status Monitoring**: Real-time status untuk setiap node
- **Geographic Visualization**: Posisi geografis perangkat
- **Interactive Details**: Klik pada node untuk informasi detail

## 🔐 Keamanan

- JWT-based authentication dengan refresh token
- Role-based access control (Admin/User)
- Password hashing dengan bcrypt
- CORS configuration untuk keamanan API

## 🐳 Docker Support

Project ini mendukung Docker untuk deployment yang mudah:

```bash
# Build image
docker build -t genieacs-panel .

# Run container
docker run -p 3001:3001 -e DB_HOST=your-db-host genieacs-panel
```

## 🤝 Kontribusi

Kontribusi sangat welcome! Silakan:

1. Fork repository
2. Buat feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add some AmazingFeature'`)
4. Push ke branch (`git push origin feature/AmazingFeature`)
5. Buka Pull Request

## 📝 License

Project ini dilisensikan under MIT License - lihat file [LICENSE](LICENSE) untuk detail.

## 🆘 Troubleshooting

### Common Issues

1. **Database Connection Error**
   - Pastikan MySQL server running
   - Cek credential di .env file
   - Verifikasi database sudah dibuat

2. **GenieACS Connection Failed**
   - Verifikasi GenieACS server URL
   - Cek firewall settings
   - Pastikan GenieACS API accessible

3. **Frontend Build Error**
   - Hapus node_modules dan package-lock.json
   - Jalankan `npm install` kembali
   - Cek Node.js version compatibility

## 📞 Support

Untuk support atau pertanyaan:
- Email: support@skydash.net
- GitHub Issues: https://github.com/skydashnet/server/issues

---

**© 2024 SkydashNET. All rights reserved.**