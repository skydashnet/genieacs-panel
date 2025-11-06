/** @type {import('next').NextConfig} */
const nextConfig = {
  // Comment out static export to enable server-side features
  // output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true
  },
  // Enable API routes and other server-side features
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL || 'http://localhost:3000'}/api/:path*`,
      },
    ]
  },
}

module.exports = nextConfig