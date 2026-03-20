import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/blog',
        destination: '/en/general',
        permanent: true,
      },
      {
        source: '/blog/:path*',
        destination: '/en/general',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
