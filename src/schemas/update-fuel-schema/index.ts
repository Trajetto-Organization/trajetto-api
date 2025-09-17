import { z } from "zod";
import { MultipartFile } from "@fastify/multipart";

const hasSpaceAtEdges = (value: string) => /^\s|\s$/.test(value);
const isEmptyOrWhitespace = (value: string): boolean =>
  value.trim().length === 0;
const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);

// Helper function to convert empty strings to null
const emptyStringToNull = (value: any) => {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  return value;
};

const isValidDateString = (value: string): boolean => {
  const date = new Date(value);
  return !isNaN(date.getTime());
};

const updateFuelSchema = z.object({
  current_mileage: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        if (val.trim() === "") return undefined;
        return parseFloat(val.replace(",", "."));
      }
      return val;
    },
    z
      .number({
        invalid_type_error: "A quilometragem atual deve ser um número válido.",
      })
      .nonnegative("A quilometragem atual deve ser um valor não negativo.")
      .min(0.1, "A quilometragem atual deve ser maior que zero.")
      .max(9999999, "A quilometragem atual não pode exceder 9.999.999 km.")
      .optional(),
  ),
  liters_amount: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        if (val.trim() === "") return undefined;
        return parseFloat(val.replace(",", "."));
      }
      return val;
    },
    z
      .number({
        invalid_type_error: "A quantidade de litros deve ser um número válido.",
      })
      .positive("A quantidade de litros deve ser um valor positivo.")
      .min(0.001, "A quantidade de litros deve ser maior que zero.")
      .max(99999.999, "A quantidade de litros não pode exceder 99.999,999 L.")
      .optional(),
  ),
  price_per_liter: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        if (val.trim() === "") return undefined;
        return parseFloat(val.replace(",", "."));
      }
      return val;
    },
    z
      .number({
        invalid_type_error: "O preço por litro deve ser um número válido.",
      })
      .positive("O preço por litro deve ser um valor positivo.")
      .min(0.001, "O preço por litro deve ser maior que zero.")
      .max(99.999, "O preço por litro não pode exceder R$ 99,999.")
      .optional(),
  ),
  odometer_photo: z
    .string()
    .min(1, "A foto do odômetro deve ser fornecida.")
    .optional(),
  odometer_verified: z.boolean().optional(),
  notes: z.preprocess(
    emptyStringToNull,
    z
      .string()
      .max(500, "As observações devem ter no máximo 500 caracteres.")
      .optional()
      .nullable()
      .superRefine((value, ctx) => {
        if (value && typeof value === "string") {
          if (isEmptyOrWhitespace(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "As observações não podem conter apenas espaços.",
            });
            return;
          }

          if (hasConsecutiveSpaces(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "As observações não devem conter espaços consecutivos.",
            });
            return;
          }

          if (hasSpaceAtEdges(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "As observações não podem começar ou terminar com espaço em branco.",
            });
            return;
          }
        }
      }),
  ),
  refueling_date: z
    .string()
    .min(1, "A data do abastecimento é obrigatória.")
    .superRefine((val, ctx) => {
      if (!isValidDateString(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Data do abastecimento inválida.",
        });
        return;
      }

      // Validation: refueling date cannot be in the future
      const refuelingDate = new Date(val);
      const today = new Date();

      today.setHours(23, 59, 59, 999); // End of today

      if (refuelingDate > today) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A data do abastecimento não pode ser no futuro.",
        });
        return;
      }
    })
    .optional(),
  vehicleId: z
    .string()
    .uuid("O ID do veículo deve ser um UUID válido.")
    .optional(),
  driverId: z
    .string()
    .uuid("O ID do motorista deve ser um UUID válido.")
    .optional(),
  fuelTypeId: z
    .string()
    .uuid("O ID do tipo de combustível deve ser um UUID válido.")
    .optional(),
  branchId: z
    .string()
    .uuid("O ID da filial deve ser um UUID válido.")
    .optional(),
});

// Schema for optional file validation in update
const odometerPhotoUpdateSchema = z
  .custom<MultipartFile>()
  .optional()
  .refine(
    (file) => {
      if (!file) return true; // Optional file
      return file?.mimetype?.startsWith("image/");
    },
    {
      message: "O arquivo deve ser uma imagem.",
    },
  )
  .refine(
    (file) => {
      if (!file) return true; // Optional file

      const allowedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
      ];
      return allowedTypes.includes(file?.mimetype);
    },
    {
      message: "Tipo de arquivo não suportado. Use apenas JPEG, PNG ou WebP.",
    },
  );

// Combined schema for multipart update request
const updateFuelMultipartSchema = z.object({
  body: updateFuelSchema,
  file: odometerPhotoUpdateSchema,
});

export {
  updateFuelSchema,
  odometerPhotoUpdateSchema,
  updateFuelMultipartSchema,
};
