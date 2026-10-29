import {
  Shipper,
  CreateShipperProps,
  UpdateShipperProps,
  ListShippersProps,
  ListShippersPage,
  SearchShipperWithCursorProps,
  CursorPaginatedShipper,
} from "../dtos/shipper-dto";

interface IShipperRepository {
  createShipper: (shipperData: CreateShipperProps) => Promise<Shipper>;
  /**
   * The page (search + Status filter, in the list's order) and, over the
   * search alone, the count per status with how many carry a CNPJ.
   */
  listShippers: (props: ListShippersProps) => Promise<ListShippersPage>;
  searchShipperWithCursor: (
    props: SearchShipperWithCursorProps,
  ) => Promise<CursorPaginatedShipper>;
  findShipperById: (shipperId: string) => Promise<Shipper | null>;
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
