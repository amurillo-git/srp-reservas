import { Suspense } from "react";
import { ReservationLookup } from "@/components/booking/reservation-lookup";

export default function MiReservaPage() {
  return (
    <div className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <Suspense fallback={null}>
        <ReservationLookup />
      </Suspense>
    </div>
  );
}
