import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { iniciarWorkerExpiracion } from "./expiracion-worker.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("iniciarWorkerExpiracion", () => {
  it("ejecuta una pasada inmediatamente al iniciar", () => {
    const pasada = vi.fn().mockResolvedValue(undefined);

    iniciarWorkerExpiracion(pasada, 1000);

    expect(pasada).toHaveBeenCalledTimes(1);
  });

  it("ejecuta una nueva pasada cada intervaloMs", async () => {
    const pasada = vi.fn().mockResolvedValue(undefined);
    iniciarWorkerExpiracion(pasada, 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pasada).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pasada).toHaveBeenCalledTimes(3);
  });

  it("no solapa pasadas: si la anterior sigue en curso, el tick se salta", async () => {
    let resolverPrimera: (() => void) | undefined;
    const pasada = vi.fn().mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolverPrimera = resolve; }),
    ).mockResolvedValue(undefined);

    iniciarWorkerExpiracion(pasada, 1000);
    expect(pasada).toHaveBeenCalledTimes(1); // primera pasada en curso, sin resolver

    await vi.advanceTimersByTimeAsync(1000); // tick durante la pasada en curso: se salta
    expect(pasada).toHaveBeenCalledTimes(1);

    resolverPrimera?.();
    await vi.advanceTimersByTimeAsync(1000); // ahora si corre la siguiente
    expect(pasada).toHaveBeenCalledTimes(2);
  });

  it("sigue funcionando tras un error en una pasada", async () => {
    const onError = vi.fn();
    const pasada = vi.fn()
      .mockRejectedValueOnce(new Error("fallo simulado"))
      .mockResolvedValue(undefined);

    iniciarWorkerExpiracion(pasada, 1000, onError);
    await vi.advanceTimersByTimeAsync(0); // deja que la promesa rechazada se asiente

    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pasada).toHaveBeenCalledTimes(2);
  });

  it("detener() detiene el worker", async () => {
    const pasada = vi.fn().mockResolvedValue(undefined);
    const worker = iniciarWorkerExpiracion(pasada, 1000);

    worker.detener();
    await vi.advanceTimersByTimeAsync(5000);

    expect(pasada).toHaveBeenCalledTimes(1); // solo la pasada inicial
  });
});
