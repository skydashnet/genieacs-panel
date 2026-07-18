/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV === 'development'

const nextConfig = {
  trailingSlash: true,
  images: {
    unoptimized: true
  },
  reactStrictMode: false,
  ...(isDev
    ? {
        async rewrites() {
          return [
            {
              source: '/api/:path*',
              destination: `${process.env.API_URL || 'http://localhost:5890'}/api/:path*`,
            },
          ]
        },
      }
    : {
        output: 'export',
      }),
}

module.exports = nextConfig
