import { describe, it } from "vitest";

// Casos de prueba prioritarios del motor de disponibilidad (seccion 24 de
// propuesta.md). Se estructuran aqui como pendientes (`it.todo`) para que el
// motor puro (a implementar en `motor-disponibilidad.ts` durante la Etapa 2
// del plan) los desarrolle uno por uno junto con la logica real. Ningun caso
// debe marcarse como implementado hasta que exista una asercion real que lo
// verifique.

describe("Motor de disponibilidad — casos DISP", () => {
  it.todo("DISP-001: reserva de 5 personas en dia vacio -> un heat y una limpieza");
  it.todo(
    "DISP-002: reserva de 6 personas en dia vacio -> dos heats de 3 + 3; primera opcion 9:00; limpieza interna posterior",
  );
  it.todo(
    "DISP-003: reserva de 15 personas en dia vacio -> tres heats de 5 + 5 + 5; primera opcion 9:00",
  );
  it.todo(
    "DISP-004: reserva de 16 personas en dia vacio -> cuatro heats de 4 + 4 + 4 + 4; primera opcion 9:00",
  );
  it.todo("DISP-005: heat con 2 personas y nueva reserva de 3 -> comparten el heat");
  it.todo(
    "DISP-006: heat con 2 personas y nueva reserva de 4 -> la hora no se ofrece; el grupo no cabe en un heat",
  );
  it.todo(
    "DISP-007: heat de 11:45 con almuerzo a las 12:00 -> no puede ser el ultimo heat de un lote porque la limpieza se cruza",
  );
  it.todo(
    "DISP-008: ocho personas desde 11:30 -> la hora no se ofrece porque el lote y su limpieza cruzan el almuerzo",
  );
  it.todo(
    "DISP-009: veinte personas desde 11:00 -> quince antes del almuerzo y cinco despues, en dos lotes",
  );
  it.todo(
    "DISP-010: heat completo a las 10:00 y diez personas desde 9:30 -> la hora no se ofrece porque la limpieza del lote se cruza con el heat existente",
  );
  it.todo(
    "DISP-011: heat completo a las 10:00 y diez personas desde 9:15 -> dos heats y limpieza terminan exactamente a las 10:00",
  );
  it.todo("DISP-012: ultimo heat a las 3:30 -> permitido; limpieza termina a las 4:00");
  it.todo("DISP-013: diez personas desde las 3:15 -> dos heats y limpieza terminan a las 4:00");
  it.todo("DISP-014: quince personas desde las 3:00 -> tres heats y limpieza terminan a las 4:00");
  it.todo(
    "DISP-015: ampliar un lote de uno a dos heats -> se mueve la limpieza solo si el nuevo intervalo esta libre",
  );
  it.todo("DISP-016: reserva de 7 personas -> distribucion 4 + 3 o 3 + 4; nunca 5 + 2");
  it.todo("DISP-017: reserva de 11 personas -> distribucion 4 + 4 + 3 en cualquier orden compatible");
  it.todo("DISP-018: reserva de 14 personas -> distribucion 5 + 5 + 4 en cualquier orden compatible");
  it.todo(
    "DISP-019: dia vacio, grupo de 5 -> ofrece 9:00, 9:15, 9:30 y cada inicio valido hasta 11:30 antes del almuerzo",
  );
  it.todo(
    "DISP-020: dia vacio, grupo de 6 -> ofrece 9:00, 9:15, 9:30 y cada inicio valido hasta 11:15 antes del almuerzo",
  );
  it.todo(
    "DISP-021: grupo de 6 reservado a las 9:15; nueva solicitud de 5 -> no ofrece 9:00-9:45; el primer inicio libre es 10:00",
  );
});
