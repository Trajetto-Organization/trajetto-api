import { describe, expect, it } from "vitest";

import { isValidCpf } from "@/modules/user/services/driver-cpf";
import { isValidCnpj } from "@/shared/delivery/cnpj";

import {
  simulatedCnpj,
  simulatedCpf,
  simulatedPlate,
  simulatedRenavam,
} from "./documents";

// Checked with the API's own validators: a simulated driver whose CPF the
// login refuses could only enter by QR code, and the scene would lie.
describe("simulated documents", () => {
  it("are CPFs the API's login accepts, all different", () => {
    const cpfs = Array.from({ length: 10 }, (_, index) =>
      simulatedCpf(index + 1),
    );

    for (const cpf of cpfs) {
      expect(cpf).toMatch(/^\d{11}$/);
      expect(isValidCpf(cpf), cpf).toBe(true);
    }

    expect(new Set(cpfs).size).toBe(cpfs.length);
  });

  it("are CNPJs the API accepts", () => {
    for (let n = 1; n <= 10; n += 1) {
      const cnpj = simulatedCnpj(n);

      expect(cnpj).toMatch(/^\d{14}$/);
      expect(isValidCnpj(cnpj), cnpj).toBe(true);
    }
  });

  it("are plates in the vehicle form's pattern and 11-digit RENAVAMs", () => {
    for (let n = 1; n <= 10; n += 1) {
      expect(simulatedPlate(n)).toMatch(/^[A-Z]{3}\d[A-Z0-9]\d{2}$/);
      expect(simulatedRenavam(n)).toMatch(/^\d{11}$/);
    }
  });
});
