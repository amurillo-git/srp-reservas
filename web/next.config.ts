import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sitio 100% estatico: ninguna pagina hace fetch en el servidor, no hay
  // rutas API ni segmentos dinamicos — todo el flujo llama a la API del
  // backend (otro origen) desde el cliente. Permite hospedar esto como un
  // sitio estatico simple (ej. Hostinger), sin un segundo proceso Node.
  output: "export",
  // Este proyecto vive en web/ dentro del repo del backend (que tiene su
  // propio package-lock.json): sin esto, Next.js detecta ambos lockfiles y
  // adivina mal la raiz del workspace.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
