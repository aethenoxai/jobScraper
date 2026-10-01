import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  // Also set by scripts/web.ts; repeated here for `next start` run directly. No other site may frame the app.
  headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
  experimental: {
    // CV uploads go through server actions; allow up to 10 MB files plus multipart overhead.
    serverActions: { bodySizeLimit: '11mb' },
  },
};

export default nextConfig;
