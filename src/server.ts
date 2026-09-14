import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { PrismaClient } from "@prisma/client";
import { crearRouterReservas } from "./http/reservas.router.js";

const app = express();
const prisma = new PrismaClient();

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

// No escuchar puerto durante las pruebas (Vitest fija NODE_ENV=test): los
// tests HTTP importan `app` y lo montan ellos mismos via supertest.
if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`API de Sarapiquí Race Park escuchando en el puerto ${port}`);
  });
}

export { app };
