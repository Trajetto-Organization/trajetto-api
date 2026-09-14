import {
  OccurrenceType,
  CreateOccurrenceTypeProps,
  UpdateOccurrenceTypeProps,
  ListOccurrenceTypesProps,
  ListOccurrenceTypesResult,
} from "../dtos/occurrence-type-dto";

interface IOccurrenceTypeRepository {
  createOccurrenceType: (
    occurrenceTypeData: CreateOccurrenceTypeProps,
  ) => Promise<OccurrenceType>;
  listOccurrenceTypes: (
    props: ListOccurrenceTypesProps,
  ) => Promise<ListOccurrenceTypesResult>;
  /** The driver's vocabulary: active types only, lean payload. */
  listActiveOccurrenceTypes: (businessId: string) => Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      requires_photo: boolean;
      blocks_delivery: boolean;
    }>
  >;
  findOccurrenceTypeById: (
    occurrenceTypeId: string,
  ) => Promise<OccurrenceType | null>;
  countOccurrenceTypesSummary: (businessId: string) => Promise<{
    total: number;
    active: number;
    blocking: number;
    requiringPhoto: number;
  }>;
  findOccurrenceTypeByName: (
    businessId: string,
    name: string,
  ) => Promise<OccurrenceType | null>;
  updateOccurrenceType: (
    occurrenceTypeId: string,
    occurrenceTypeData: UpdateOccurrenceTypeProps,
  ) => Promise<OccurrenceType>;
  deleteOccurrenceType: (occurrenceTypeId: string) => Promise<OccurrenceType>;
  countOccurrencesByTypeId: (occurrenceTypeId: string) => Promise<number>;
}

export { IOccurrenceTypeRepository };
