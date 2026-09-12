# Sarapiquí Race Park — Plataforma de reservas (MVP de karts)

Repositorio remoto: https://github.com/amurillo-git/srp-reservas

Este código es generado en su totalidad por Claude Code. El Product Owner /
Administrador del proyecto es el único responsable humano de las decisiones
de producto; Claude Code actúa como el ingeniero de software que implementa
la especificación funcional definida en [`propuesta.md`](propuesta.md).

## Resumen ejecutivo del MVP

La plataforma permite que una persona consulte la disponibilidad real,
seleccione una fecha y una hora, reserve espacios para una cantidad
determinada de participantes y pague un depósito equivalente al 50 % del
monto total. La reserva queda confirmada automáticamente cuando el depósito
se paga mediante una pasarela de tarjeta que permita verificar la
transacción. Cuando el pago se realiza por SINPE, una persona autorizada de
Sarapiquí Race Park debe validar el depósito.

El producto mínimo viable (**MVP**) se concentra en las reservas de **karts**.
El agente conversacional con inteligencia artificial y el alquiler de
vehículos de radiocontrol (RC) se incorporarán posteriormente sobre los
mismos servicios de disponibilidad, reservación y pago.

La decisión técnica central es modelar la operación mediante bloques de 15
minutos y lotes operativos. Cada heat ocupa un bloque y admite hasta cinco
personas. Un lote contiene uno o más heats consecutivos y termina con un
bloque interno de 15 minutos para limpiar y preparar los karts. Diferentes
reservas pueden compartir un heat siempre que la suma de participantes no
supere cinco. Las personas de una misma reserva se distribuyen de la forma
más equilibrada posible entre sus heats: la diferencia entre el heat con más
participantes y el heat con menos participantes no puede superar una
persona. Las reservas de hasta 15 personas deben completarse en un solo
lote, sin pausas entre sus heats. Las reservas de más de 15 personas también
se intentarán programar como un único lote; si la disponibilidad no lo
permite, podrán dividirse en varios lotes separados por el almuerzo, otras
reservas o cualquier indisponibilidad.

El MVP incluye: página pública de reservas responsive, cálculo automático de
heats y lotes, distribución equitativa de participantes, bloqueo obligatorio
de limpieza, horario semanal configurable con excepciones y bloqueos,
reserva temporal de 30 minutos, depósito del 50 %, pago por SINPE con
validación manual, integración con pasarela de tarjeta con confirmación
automática, panel administrativo completo y auditoría básica. Quedan fuera
del MVP: agente de IA, atención automatizada por mensajería, app móvil
nativa, fidelización, CRM avanzado y el alquiler de vehículos RC.

La especificación funcional y técnica completa —objetivos, alcance, modelo
matemático de programación, motor de disponibilidad, ejemplos de
programación, estados de reserva, pagos, panel administrativo, modelo de
datos, arquitectura, API, requisitos no funcionales, criterios de aceptación
y casos de prueba— vive en [`propuesta.md`](propuesta.md) y es la fuente de
verdad del proyecto.

## Actores del sistema

| Actor | Responsabilidad principal |
|---|---|
| Cliente | Consultar disponibilidad, seleccionar heats, proporcionar datos, pagar el depósito y recibir confirmación. |
| Personal de atención | Brindar información, enviar el enlace de reservas y apoyar al cliente cuando sea necesario. |
| Operador del parque | Consultar el calendario operativo, participantes y distribución de heats. |
| Administrador | Configurar horarios, bloqueos, precios y usuarios; gestionar reservas y validar SINPE. |
| Pasarela de pago | Generar el enlace de pago, procesar la tarjeta y notificar el resultado. |
| Agente de IA futuro | Responder preguntas y dirigir al cliente al proceso de reservación sin modificar directamente las reglas del calendario. |

## Estructura del proyecto

```text
.
├── prisma/
│   └── schema.prisma        # Datasource PostgreSQL y generator de Prisma Client
├── src/
│   ├── server.ts             # Punto de entrada de la API Express
│   └── motor-disponibilidad/
│       └── motor-disponibilidad.test.ts  # 21 casos DISP-001..DISP-021 (Vitest, pendientes)
├── .env.example               # Plantilla de variables de entorno
├── claudecode.json             # Reglas de calidad para la generación de código
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Cómo empezar

```bash
npm install
cp .env.example .env   # completar DATABASE_URL con la base PostgreSQL real
npm run prisma:generate
npm run dev
```

Pruebas del motor lógico:

```bash
npm test
```

---

## Glosario operativo

> Copiado sin alteraciones de `propuesta.md`, sección 5, para que quede
> indexado localmente como verdad de diseño absoluta.

| Término | Definición |
|---|---|
| Bloque | Unidad mínima de tiempo del sistema, con una duración de 15 minutos. |
| Heat | Periodo de 15 minutos en el que participan hasta cinco personas. |
| Capacidad del heat | Cinco personas en total, aunque pertenezcan a diferentes reservas. |
| Lote operativo | Secuencia de uno o más heats consecutivos seguida por un bloque de limpieza. |
| Limpieza | Bloque de 15 minutos inmediatamente posterior al último heat de un lote operativo. |
| Asignación | Cantidad de personas de una reserva colocadas en un heat determinado. |
| Plan de reserva | Conjunto ordenado de lotes y heats asignados a una reserva. |
| Hora de inicio | Hora del primer heat asignado a la reserva. |
| Fin de actividad del cliente | Fin del último heat asignado al grupo; no incluye limpieza. |
| Liberación operativa | Fin de la limpieza del último lote asignado; se utiliza internamente para calcular disponibilidad. |
| Reserva temporal | Retención de capacidad durante 30 minutos mientras se gestiona el depósito. |
| Reserva confirmada | Reserva cuyo depósito fue validado. |
| Excepción de calendario | Regla aplicable a una fecha concreta que abre, cierra o modifica el horario habitual. |
| Bloqueo administrativo | Periodo no reservable creado por una persona autorizada. |

---

## Reglas de negocio definitivas

> Copiadas sin alteraciones de `propuesta.md`, secciones 6.1 a 6.9, para que
> queden indexadas localmente como verdades de diseño absolutas. Ninguna
> implementación puede contradecir lo aquí escrito; cualquier cambio de
> regla debe actualizarse primero en `propuesta.md` y luego reflejarse aquí.

### 6.1 Duración y capacidad

1. La unidad mínima de programación será de 15 minutos.
2. Cada heat durará 15 minutos.
3. Cada heat tendrá una capacidad máxima de cinco personas.
4. El sistema permitirá varias reservas dentro del mismo heat si la suma de participantes no supera cinco.
5. Un lote operativo podrá contener uno o más heats consecutivos.
6. Después del último heat de cada lote se bloquearán 15 minutos para limpieza y preparación.
7. El bloque de limpieza será global. Durante ese periodo no podrá realizarse ningún heat.
8. Una reserva de hasta 15 personas deberá completarse en un solo lote. Sus heats no podrán separarse.
9. Una reserva de más de 15 personas se intentará programar primero como un solo lote con todos sus heats consecutivos y una sola limpieza.
10. Si ese lote continuo no cabe, la reserva podrá dividirse en dos o más lotes. Cada lote tendrá una limpieza propia.
11. Los lotes de una reserva superior a 15 personas podrán separarse por otros lotes, limpiezas, el almuerzo, eventos privados u otros periodos no disponibles.
12. Dentro de cada lote, los heats siempre serán consecutivos.
13. El motor minimizará la cantidad de lotes y, por tanto, la cantidad de limpiezas.
14. Todos los lotes de una reserva deberán asignarse dentro de la misma fecha en el MVP.
15. No se establece un máximo comercial de personas por reserva. El límite efectivo dependerá de la capacidad restante del día.
16. La distribución de una reserva entre sus heats deberá ser equitativa: la diferencia entre la mayor y la menor asignación será como máximo de una persona.
17. El bloque de limpieza se utilizará para validar disponibilidad, pero no se mostrará como parte de la duración de la actividad del cliente.

### 6.2 Horario habitual

La configuración inicial será:

| Día | Horario |
|---|---|
| Sábado | 9:00 a. m. a 4:00 p. m. |
| Domingo | 9:00 a. m. a 4:00 p. m. |
| Feriado habilitado | 9:00 a. m. a 4:00 p. m. |
| Almuerzo | 12:00 m. a 12:30 p. m. |

Los días y las horas deberán ser configurables. Los feriados no se asumirán
abiertos automáticamente; una persona administradora deberá habilitar cada
fecha que corresponda.

### 6.3 Restricciones del almuerzo

1. No se podrá programar un heat entre las 12:00 y las 12:30.
2. Tampoco se podrá colocar un bloque de limpieza dentro del almuerzo.
3. El último heat de un lote no podrá finalizar a las 12:00 porque su limpieza se cruzaría con el almuerzo.
4. Un lote de dos heats podrá operar de 11:15 a 11:45 y realizar la limpieza de 11:45 a 12:00.
5. Una reserva de hasta 15 personas no podrá dividir su único lote alrededor del almuerzo.
6. Una reserva superior a 15 personas podrá colocar uno o más lotes antes del almuerzo y continuar con otros lotes después de las 12:30.

### 6.4 Restricciones de apertura y cierre

1. Cada lote, incluidos todos sus heats y su limpieza, deberá estar completamente contenido dentro de un periodo abierto.
2. El último heat de un lote podrá terminar antes del cierre únicamente si todavía existe un bloque abierto de 15 minutos para la limpieza. Por esta razón, con cierre a las 4:00 p. m., el último heat posible comienza a las 3:30 p. m.
3. Ninguna limpieza podrá extenderse después de las 4:00 p. m., salvo que una excepción amplíe el horario de esa fecha.
4. Una fecha podrá tener varios intervalos abiertos, siempre que cada lote completo esté dentro de uno de esos intervalos.

### 6.5 Capacidad compartida

La capacidad disponible de un heat se calculará así:

```text
capacidad_disponible = 5 - participantes_retenidos - participantes_confirmados
```

Se consideran participantes retenidos los asociados a reservas temporales
vigentes o a pagos SINPE pendientes de validación.

Ejemplos:

| Ocupación actual | Nueva solicitud | Resultado |
|---:|---:|---|
| 0 | 5 | Se asignan las cinco personas. |
| 1 | 4 | Se comparten los cinco espacios. |
| 2 | 3 | Se comparten los cinco espacios. |
| 2 | 4 | La reserva de cuatro no cabe completa y debe usar otro heat con al menos cuatro espacios. |
| 4 | 2 | La reserva de dos no cabe completa y debe usar otro heat con al menos dos espacios. |
| 5 | 1 | El heat no tiene capacidad disponible. |

### 6.6 División en lotes

Para reservas de hasta 15 personas, el sistema deberá encontrar un solo lote
con la cantidad necesaria de heats consecutivos y su limpieza. No podrá
saltar un bloque ocupado para completar ese lote.

Para reservas de más de 15 personas, el sistema intentará primero una
secuencia continua con todos los heats y una sola limpieza. Si no cabe,
podrá dividir la solicitud. Cada lote conservará sus heats consecutivos,
pero el sistema podrá saltar cualquier periodo no utilizable antes de
programar el siguiente lote. La separación puede deberse a:

- Otro lote o heat ocupado.
- Una limpieza.
- El almuerzo.
- Un evento privado.
- Mantenimiento.
- Un cierre parcial.
- Una reserva temporal vigente.

El sistema buscará primero el plan con menos lotes y, entre planes
equivalentes, el que termine más temprano. La interfaz mostrará todas las
pausas antes de que el cliente confirme.

### 6.7 Reserva temporal y depósito

1. La reserva temporal durará 30 minutos.
2. El contador comenzará cuando el servidor confirme la retención de los heats, no mientras el cliente explora el calendario.
3. Durante esos 30 minutos, la capacidad retenida no podrá asignarse a otra persona.
4. El depósito será el 50 % del total de la reserva.
5. Si no se registra ninguna acción de pago antes del vencimiento, la reserva expirará automáticamente.
6. Al expirar, se liberarán las asignaciones. Si el lote conserva otras reservas, permanecerá activo.
7. Si el lote queda completamente vacío, se eliminarán sus heats y se liberará su limpieza.
8. Si solo algunos heats quedan vacíos, el sistema normalizará el lote sin afectar las asignaciones restantes. Podrá retirar heats vacíos al inicio o al final y reposicionar la limpieza. Un heat vacío entre dos heats ocupados permanecerá como parte del lote y podrá recibir nuevas reservas.

### 6.8 Pago mediante tarjeta

1. La reserva permanecerá temporal mientras el cliente completa el pago.
2. La plataforma generará un enlace relacionado con el identificador de la reserva.
3. La confirmación dependerá de una notificación verificable de la pasarela y de una consulta de validación cuando el proveedor lo permita.
4. La página de retorno del navegador no será evidencia suficiente para confirmar el pago.
5. La operación deberá ser idempotente: una misma notificación no podrá aplicar dos pagos ni confirmar dos veces una reserva.
6. Si el pago se completa correctamente, la reserva pasará a confirmada de inmediato.
7. El proveedor de pagos queda pendiente de selección.

### 6.9 Pago mediante SINPE

1. El cliente recibirá el número SINPE, el monto exacto y una referencia de reserva.
2. Deberá reportar el pago antes de que terminen los 30 minutos.
3. El formulario podrá solicitar comprobante, nombre del pagador, número de origen y referencia de la transacción.
4. Cuando el comprobante se presente a tiempo, la reserva pasará a pendiente de validación.
5. Mientras se encuentre pendiente de validación, la capacidad permanecerá retenida sin depender del temporizador inicial.
6. Una persona autorizada aprobará o rechazará el depósito.
7. La aprobación confirmará la reserva.
8. El rechazo deberá registrar un motivo y permitirá cancelar la reserva o conceder un nuevo plazo.
