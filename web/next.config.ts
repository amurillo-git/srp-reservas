import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Este proyecto vive en web/ dentro del repo del backend (que tiene su
  // propio package-lock.json): sin esto, Next.js detecta ambos lockfiles y
  // adivina mal la raiz del workspace.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
