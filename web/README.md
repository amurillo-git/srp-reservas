# SRP Reservas — Web (flujo público de reserva)

App Next.js (App Router, TypeScript, Tailwind CSS + shadcn/ui) que implementa el flujo público de reserva de karts para Sarapiquí Race Park, consumiendo la API del backend (carpeta `../src`). No incluye landing page (el sitio principal ya existe en sarapiquiracepark.com) ni el panel administrativo.

## Configuración

```bash
npm install
cp .env.example .env.local   # completar NEXT_PUBLIC_API_URL y NEXT_PUBLIC_SINPE_PHONE
npm run dev -- -p 3001       # el backend ya usa el puerto 3000
```

El backend (`../src/server.ts`) debe estar corriendo y tener `WEB_APP_URL` configurado con el origen de esta app (ver `../.env.example`) para que CORS permita las llamadas.

## Estructura

- `src/app/page.tsx` — página raíz: header + `BookingWizard`.
- `src/app/mi-reserva/page.tsx` — consulta de una reserva por código público.
- `src/components/booking/` — el wizard (personas → fecha → hora → datos → revisión → pago SINPE → confirmación) y sus pasos.
- `src/lib/api.ts` — cliente delgado de la API pública del backend.
- `src/lib/types.ts` — espejo tipado de las respuestas del backend.

## Limitaciones conocidas / pendientes

- **Precio de servicio**: soportado como tarifa escalonada por tamaño de grupo (`Service.precioPorPersonaGrupoPequeno` 1-4 personas, `precioPorPersonaGrupoGrande` 5+), calculada en `motor-disponibilidad.ts` (`calcularPrecio`, umbral `UMBRAL_GRUPO_GRANDE = 5`). Solo se ofrecen heats de 15 minutos (decisión del negocio: no se maneja la variante de 10 min).
- **Comprobante SINPE**: el formulario de pago solo recoge texto (nombre, número de origen, referencia); no hay subida de imagen del comprobante — el backend no tiene ese endpoint todavía.
- **Rendimiento de `GET /availability/dates`**: el calendario de un mes puede tardar ~20-30s en cargar porque el backend consulta cada día del mes secuencialmente contra Supabase. Pendiente de optimizar (candidato: paralelizar o consultar el mes completo en una sola pasada).
- Sin panel admin, sin gestión de horarios, sin pago con tarjeta (ver `../HANDOFF.md`-equivalente / backlog del proyecto).
