import { describe, expect, it } from "vitest";
import { crearLimitadorIntentos } from "./limitador-intentos.js";

describe("crearLimitadorIntentos", () => {
  it("permite hasta `max` intentos por ventana y rechaza el siguiente", () => {
    const ahora = 1_000;
    const limitar = crearLimitadorIntentos({ max: 3, ventanaMs: 60_000, ahora: () => ahora });

    expect(limitar("ip-1").permitido).toBe(true);
    expect(limitar("ip-1").permitido).toBe(true);
    expect(limitar("ip-1").permitido).toBe(true);
    const cuarto = limitar("ip-1");
    expect(cuarto.permitido).toBe(false);
    expect(cuarto.reintentarEnSeg).toBe(60);
  });

  it("cada clave tiene su propio contador", () => {
    const limitar = crearLimitadorIntentos({ max: 1, ventanaMs: 60_000, ahora: () => 0 });

    expect(limitar("ip-1").permitido).toBe(true);
    expect(limitar("ip-2").permitido).toBe(true);
    expect(limitar("ip-1").permitido).toBe(false);
  });

  it("al terminar la ventana el contador se reinicia", () => {
    let ahora = 0;
    const limitar = crearLimitadorIntentos({ max: 1, ventanaMs: 60_000, ahora: () => ahora });

    expect(limitar("ip-1").permitido).toBe(true);
    ahora = 59_999;
    expect(limitar("ip-1").permitido).toBe(false);
    ahora = 60_000;
    expect(limitar("ip-1").permitido).toBe(true);
  });

  it("informa cuantos segundos faltan para poder reintentar", () => {
    let ahora = 0;
    const limitar = crearLimitadorIntentos({ max: 1, ventanaMs: 60_000, ahora: () => ahora });

    limitar("ip-1");
    ahora = 45_500;

    expect(limitar("ip-1").reintentarEnSeg).toBe(15);
  });
});
