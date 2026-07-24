# SkyGenPanel Frontend

Frontend Vite + React Router yang dibangun sebagai SPA statis dan disajikan oleh backend pada origin yang sama.

## Menjalankan

Butuh Node.js 20 atau lebih baru.

```bash
npm ci --include=dev
npm run dev
```

Development server meneruskan `/api` ke backend lokal. Tidak diperlukan `VITE_API_URL`; client secara default memakai path relatif `/api`.

## Pemeriksaan production

```bash
npm run lint
npm run typecheck
npm run build
npm audit
```

Hasil build berada di `dist/` dan otomatis disajikan oleh backend dalam deployment single-service.
