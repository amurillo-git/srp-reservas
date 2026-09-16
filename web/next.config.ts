import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sitio 100% estatico: ninguna pagina hace fetch en el servidor, no hay
  // rutas API ni segmentos dinamicos — todo el flujo llama a la API del
  // backend (otro origen) desde el cliente. Permite hospedar esto como un
  // sitio estatico simple (ej. Hostinger), sin un segundo proceso Node.
  output: "export",
  // Sin esto, una ruta con subrutas (ej. /admin, con /admin/login debajo)
  // genera un archivo admin.html Y una carpeta admin/ al mismo tiempo; el
  // hosting estatico de Hostinger devuelve 403 al pedir /admin/login (sin
  // extension) porque no reescribe a $uri.html. Con trailingSlash cada
  // ruta se sirve como carpeta con su propio index.html (admin/login/index.html),
  // que cualquier servidor estatico resuelve de forma nativa.
  trailingSlash: true,
  // Este proyecto vive en web/ dentro del repo del backend (que tiene su
  // propio package-lock.json): sin esto, Next.js detecta ambos lockfiles y
  // adivina mal la raiz del workspace.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
