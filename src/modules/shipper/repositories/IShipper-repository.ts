import {
  Shipper,
  CreateShipperProps,
  UpdateShipperProps,
  ListShippersProps,
  ListShippersResult,
  SearchShipperWithCursorProps,
  CursorPaginatedShipper,
} from "../dtos/shipper-dto";

interface IShipperRepository {
  createShipper: (shipperData: CreateShipperProps) => Promise<Shipper>;
  listShippers: (props: ListShippersProps) => Promise<ListShippersResult>;
  searchShipperWithCursor: (
    props: SearchShipperWithCursorProps,
  ) => Promise<CursorPaginatedShipper>;
  findShipperById: (shipperId: string) => Promise<Shipper | null>;
  countShippersSummary: (
    businessId: string,
  ) => Promise<{ total: number; active: number; withCnpj: number }>;
  findShipperByName: (
    businessId: string,
    name: string,
  ) => Promise<Shipper | null>;
  findShipperByCnpj: (
    businessId: string,
    cnpj: string,
  ) => Promise<Shipper | null>;
  updateShipper: (
    shipperId: string,
    shipperData: UpdateShipperProps,
  ) => Promise<Shipper>;
  deleteShipper: (shipperId: string) => Promise<Shipper>;
  countDeliveriesByShipperId: (shipperId: string) => Promise<number>;
}

export { IShipperRepository };
