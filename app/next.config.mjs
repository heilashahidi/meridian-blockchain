/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Some @solana / wallet-adapter packages ship untranspiled ESM and reference
  // Node core modules that don't exist in the browser. Transpile them and stub
  // the Node-only fallbacks so the client bundle builds cleanly.
  transpilePackages: [
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@solana/wallet-adapter-wallets",
  ],
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      os: false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
