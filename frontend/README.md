# SkyGenPanel Frontend

Frontend Next.js 15 App Router yang diekspor sebagai situs statis dan disajikan oleh backend pada origin yang sama.

## Menjalankan

Butuh Node.js 20 atau lebih baru.

```bash
npm ci --include=dev
npm run dev
```

Development server meneruskan `/api` ke backend lokal. Tidak diperlukan `NEXT_PUBLIC_API_URL`; client selalu memakai path relatif `/api`.

## Pemeriksaan production

```bash
npm run lint
npm run typecheck
npm run build
npm audit
```

Hasil build berada di `out/` dan otomatis disajikan oleh backend dalam deployment single-service.
