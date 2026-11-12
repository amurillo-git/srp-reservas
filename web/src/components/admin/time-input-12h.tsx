"use client";

import { useState } from "react";

type Periodo = "AM" | "PM";

const MINUTOS_BASE = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];

const CLASE_SELECT =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function descomponer(valor: string): { hora12: string; minutos: string; periodo: Periodo } | null {
  const coincidencia = /^(\d{1,2}):(\d{2})$/.exec(valor);
  if (!coincidencia) return null;
  const horas = Number(coincidencia[1]);
  if (horas > 23) return null;
  return {
    hora12: String(horas % 12 === 0 ? 12 : horas % 12),
    minutos: coincidencia[2]!,
    periodo: horas < 12 ? "AM" : "PM",
  };
}

function a24Horas(hora12: string, minutos: string, periodo: Periodo): string {
  const horas = (Number(hora12) % 12) + (periodo === "PM" ? 12 : 0);
  return `${String(horas).padStart(2, "0")}:${minutos}`;
}

/** Selector de hora en formato de 12 horas (hora, minutos, AM/PM). A
 * diferencia de `<input type="time">`, su formato no depende de la
 * configuracion regional del navegador o del sistema operativo. El valor que
 * entrega y recibe sigue siendo "HH:mm" de 24 horas ("" = sin hora), el mismo
 * que usa la API. Minutos en pasos de 5; si el valor recibido trae otro
 * minuto, se conserva como opcion para no alterar datos existentes. */
export function TimeInput12h({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (valor: string) => void;
}) {
  // Mientras no hay hora elegida, recuerda minutos y AM/PM para que el orden
  // en que se completen los selectores no importe.
  const [pendiente, setPendiente] = useState<{ minutos: string; periodo: Periodo }>({ minutos: "00", periodo: "AM" });

  const actual = descomponer(value);
  const hora12 = actual?.hora12 ?? "";
  const minutos = actual?.minutos ?? pendiente.minutos;
  const periodo = actual?.periodo ?? pendiente.periodo;
  const opcionesMinutos = MINUTOS_BASE.includes(minutos) ? MINUTOS_BASE : [...MINUTOS_BASE, minutos].sort();

  function cambiarHora(nueva: string) {
    if (nueva === "") {
      setPendiente({ minutos, periodo });
      onChange("");
      return;
    }
    onChange(a24Horas(nueva, minutos, periodo));
  }

  function cambiarMinutos(nuevos: string) {
    if (hora12 === "") {
      setPendiente({ minutos: nuevos, periodo });
      return;
    }
    onChange(a24Horas(hora12, nuevos, periodo));
  }

  function cambiarPeriodo(nuevo: Periodo) {
    if (hora12 === "") {
      setPendiente({ minutos, periodo: nuevo });
      return;
    }
    onChange(a24Horas(hora12, minutos, nuevo));
  }

  return (
    <div className="flex items-center gap-1.5">
      <select
        id={id}
        aria-label="Hora"
        className={CLASE_SELECT}
        value={hora12}
        onChange={(e) => cambiarHora(e.target.value)}
      >
        <option value="">--</option>
        {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span aria-hidden="true">:</span>
      <select
        aria-label="Minutos"
        className={CLASE_SELECT}
        value={minutos}
        onChange={(e) => cambiarMinutos(e.target.value)}
      >
        {opcionesMinutos.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select
        aria-label="AM o PM"
        className={CLASE_SELECT}
        value={periodo}
        onChange={(e) => cambiarPeriodo(e.target.value as Periodo)}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}
