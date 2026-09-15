import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { crearRouterReservas } from "./http/reservas.router.js";
import { asegurarAdminInicial } from "./services/auth.service.js";
import { expirarReservasVencidas } from "./services/expiracion.service.js";
import { iniciarWorkerExpiracion } from "./worker/expiracion-worker.js";

const app = express();
const prisma = new PrismaClient();

// Origen de la app de reservas (Next.js, carpeta web/), separada de esta API
// (18.3): sin esto, el navegador bloquea las llamadas fetch desde otro
// origen. En produccion, WEB_APP_URL debe apuntar al dominio real.
app.use(cors({ origin: process.env.WEB_APP_URL ?? "http://localhost:3001" }));
app.use(express.json());

// Ruta de verificacion de vida del servicio (health check), util para el
// hospedaje (Hostinger Web Apps) y para monitoreo basico.
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", crearRouterReservas(prisma));

// Middleware de errores: unico lugar que atrapa lo que `conManejoDeErrores`
// (reservas.router.ts) reenvia via `next`. Sin esto, un error no manejado en
// un handler async tumbaria la conexion sin una respuesta JSON.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "Error interno del servidor" });
});

// No escuchar puerto ni tocar la base de datos durante las pruebas (Vitest
// fija NODE_ENV=test): los tests HTTP importan `app` y lo montan ellos
// mismos via supertest, con FakePrisma en vez de este PrismaClient real.
if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  const intervaloExpiracionMs = Number(process.env.EXPIRACION_INTERVALO_MS ?? 60_000);
  asegurarAdminInicial(prisma)
    .catch((error: unknown) => console.error("No se pudo asegurar el admin inicial:", error))
    .finally(() => {
      // 19.1: libera heats de reservas TEMPORAL vencidas mientras el
      // servidor esta vivo (ver src/worker/expiracion-worker.ts).
      iniciarWorkerExpiracion(() => expirarReservasVencidas(prisma), intervaloExpiracionMs);
      // "0.0.0.0" explicito: algunos proxys de hosting (ej. Hostinger) solo
      // conectan si el proceso escucha en todas las interfaces, no solo en
      // el loopback que Node podria elegir por defecto.
      app.listen(port, "0.0.0.0", () => {
        console.log(`API de Sarapiquí Race Park escuchando en el puerto ${port}`);
      });
    });
}

export { app };
