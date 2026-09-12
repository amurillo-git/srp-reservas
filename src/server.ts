import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());

// Ruta de verificacion de vida del servicio (health check), util para el
// hospedaje (Hostinger Web Apps) y para monitoreo basico.
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`API de Sarapiquí Race Park escuchando en el puerto ${port}`);
});

export { app };
