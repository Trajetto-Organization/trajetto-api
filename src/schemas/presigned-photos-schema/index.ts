import { z } from "zod";

/**
 * Photos a client uploaded straight to storage, sent back as keys.
 *
 * `fieldName` is what ties a photo to the checklist item it documents
 * (`tires_condition`, `current_mileage`, …). With multipart that came from the
 * part name; here it has to be explicit, because the key alone says nothing
 * about which question the photo answers.
 */
const presignedPhotoSchema = z.object({
  key: z
    .string()
    .min(1, "A chave do arquivo é obrigatória!")
    .max(512, "Chave de arquivo inválida."),

  fieldName: z.string().min(1).max(80).optional(),
});

const presignedPhotosSchema = z
  .array(presignedPhotoSchema)
  .max(20, "No máximo 20 fotos por checklist.")
  .optional();

export { presignedPhotoSchema, presignedPhotosSchema };
