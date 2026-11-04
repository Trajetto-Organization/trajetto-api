import { randomUUID } from "node:crypto";

import { ApiClient, type Session } from "./api-client";
import type { SimLog } from "./log";

/**
 * The dispatcher, through the real HTTP API exactly as the web's server
 * actions call it (trajetto-ui/src/actions): same paths, same bodies, the
 * panel's Idempotency-Key on the creates that carry one (IDEMP-14).
 *
 * The list endpoints answer NDJSON (`{"meta"}` first, then one item per
 * line); the creates answer only a message, so the new row is read back from
 * its list, as the web's tables do after a save.
 */
interface ListItem {
  id: string;
  [field: string]: unknown;
}

type DriverAccess =
  | { kind: "password-on-create" | "password-reset"; password: string }
  | { kind: "qr" };

interface DriverInput {
  name: string;
  cpf: string;
  email: string;
  birthDate: string;
  cnh: string;
  access: DriverAccess;
}

interface VehicleInput {
  description: string;
  plate: string;
  renavam: string;
  brand: string;
  model: string;
  mileage: number;
}

interface DeliveryInput {
  code: string;
  invoiceNumber: string;
  recipientName: string;
  recipientTelephone: string;
  street: string;
  number: string;
  district: string;
  zip: string;
  latitude: number;
  longitude: number;
  scheduledDate: string;
  items: Array<{
    description: string;
    quantity: number;
    unit: string;
    unit_value: number;
  }>;
}

interface RouteCreated {
  id: string;
  code: number;
  stops: number;
  planVersion: number;
}

class Dispatcher {
  readonly api: ApiClient;

  constructor(
    url: string,
    replica: string,
    private readonly log: SimLog,
    readonly businessId: string,
  ) {
    this.api = new ApiClient(url, replica, "despacho", log);

    // The web renews its session without a deviceId (its session is not
    // bound to a device).
    this.api.refresher = async (session: Session) => {
      const { data } = await this.api.request<{
        token: string;
        refresh_token: string;
      }>("POST", "/user/refresh-token", {
        auth: false,
        body: { token: session.refreshToken },
      });

      return { token: data.token, refreshToken: data.refresh_token };
    };
  }

  private get b(): string {
    return this.businessId;
  }

  async signIn(email: string, password: string): Promise<void> {
    const { data } = await this.api.request<{
      token?: string;
      refresh_token?: string;
      emailVerification?: boolean;
      twoFactorVerification?: boolean;
    }>("POST", "/user/session", { auth: false, body: { email, password } });

    if (!data.token || !data.refresh_token) {
      throw new Error(
        `O login do despacho não abriu sessão (${JSON.stringify(data).slice(0, 200)}).`,
      );
    }

    this.api.session = { token: data.token, refreshToken: data.refresh_token };
  }

  /** NDJSON list, items only (the first line is the meta). */
  async list(
    path: string,
    params: Record<string, string> = {},
  ): Promise<ListItem[]> {
    const query = new URLSearchParams({
      page: "1",
      pageSize: "100",
      businessId: this.b,
      ...params,
    });

    const { data } = await this.api.request<unknown[]>(
      "GET",
      `${path}?${query}`,
      {
        ndjson: true,
        headers: { Accept: "application/x-ndjson" },
      },
    );

    return (data ?? []).filter(
      (line): line is ListItem =>
        typeof line === "object" && line !== null && "id" in line,
    );
  }

  async saveSettings(settings: {
    checklist_requirement: string;
    arrival_geofence_mode: string;
    arrival_geofence_radius_m: number;
  }): Promise<void> {
    await this.api.request("PUT", `/business/${this.b}/settings`, {
      body: settings,
    });
  }

  /**
   * The company's depot as a branch. Checklists and fuelling need one: the
   * API takes the vehicle's branch, else the driver's, and refuses the
   * driver's checklist without either (BRANCH_REQUIRED).
   */
  async createBranch(input: {
    name: string;
    cnpj: string;
    street: string;
    number: string;
    zip: string;
  }): Promise<string> {
    const { data } = await this.api.request<{ id: string }>(
      "POST",
      `/branch/create-branch/${this.b}`,
      {
        body: {
          corporate_reason: `${input.name} Simulação`,
          fantasy_name: input.name,
          cnpj: input.cnpj,
          cnae: "4930202",
          cep: input.zip,
          city: "São Paulo",
          uf: "SP",
          street: input.street,
          address_number: input.number,
          email: "cd@simulacao.invalid",
          responsible_name: "Gerente do CD",
          telephone: "11900000001",
        },
      },
    );

    return data.id;
  }

  async ensureFuelType(description: string): Promise<string> {
    await this.api.request("POST", `/fuel-type/create-fuel-type/${this.b}`, {
      body: { description },
      expect: [409],
    });

    const found = (await this.list("/fuel-type/list-fuel-type")).find(
      (row) => row.description === description,
    );

    if (!found)
      throw new Error(`Tipo de combustível ${description} não encontrado.`);

    return found.id;
  }

  async createShipper(name: string, cnpj: string): Promise<string> {
    await this.api.request("POST", `/shipper/create-shipper/${this.b}`, {
      body: { name, corporate_reason: `${name} LTDA`, cnpj },
    });

    const found = (
      await this.list("/shipper/list-shipper", { search: name })
    ).find((row) => row.name === name);

    if (!found) throw new Error(`Embarcador ${name} não encontrado.`);

    return found.id;
  }

  async createOccurrenceType(body: Record<string, unknown>): Promise<string> {
    await this.api.request(
      "POST",
      `/occurrence-type/create-occurrence-type/${this.b}`,
      {
        body,
      },
    );

    const found = (
      await this.list("/occurrence-type/list-occurrence-type", {
        search: String(body.name),
      })
    ).find((row) => row.name === body.name);

    if (!found)
      throw new Error(
        `Tipo de ocorrência ${String(body.name)} não encontrado.`,
      );

    return found.id;
  }

  async createStatusReason(name: string, description: string): Promise<string> {
    await this.api.request(
      "POST",
      `/status-change-reason/create-status-change-reason/${this.b}`,
      { body: { name, description } },
    );

    const found = (
      await this.list("/status-change-reason/list-status-change-reason", {
        search: name,
      })
    ).find((row) => row.name === name);

    if (!found) throw new Error(`Motivo ${name} não encontrado.`);

    return found.id;
  }

  /** The driver's record, then the login (BUSINESS_USER bound to it). */
  async createDriver(
    input: DriverInput,
    branchId?: string,
  ): Promise<{ driverId: string; userId: string }> {
    await this.api.request("POST", `/driver/create-driver/${this.b}`, {
      body: {
        name: input.name,
        birth_date: input.birthDate,
        cnh: input.cnh,
        cnh_category: "D",
        cpf: input.cpf,
        rg: input.cpf.slice(0, 9),
        cep: "05311000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua Guaipá",
        address_number: "100",
        status: "ACTIVE",
        contract_type: "OWNED",
        ...(branchId && { branchId }),
      },
    });

    const driver = (
      await this.list("/driver/list-driver", { search: input.cpf })
    ).find((row) => row.cpf === input.cpf);

    if (!driver) throw new Error(`Motorista ${input.name} não encontrado.`);

    // D2, phase N: the manager may set the driver's first password here;
    // without it the login waits for the QR code (D3) or a reset.
    await this.api.request("POST", "/user/create-user", {
      body: {
        name: input.name,
        email: input.email,
        role: "BUSINESS_USER",
        businessId: this.b,
        driverId: driver.id,
        userType: "driver",
        ...(input.access.kind === "password-on-create" && {
          password: input.access.password,
        }),
      },
    });

    const user = (
      await this.list("/user/list-user", { search: input.email })
    ).find((row) => row.email === input.email);

    if (!user) throw new Error(`Login de ${input.name} não encontrado.`);

    if (input.access.kind === "password-reset") {
      await this.api.request("PATCH", `/user/${user.id}/driver-password`, {
        body: { password: input.access.password },
      });
    }

    return { driverId: driver.id, userId: user.id };
  }

  /** D3: the QR code the manager shows the driver's phone. */
  async issueEnrollment(
    userId: string,
  ): Promise<{ qrContent: string; qrToken: string }> {
    const { data } = await this.api.request<{
      qrContent: string;
      qrToken: string;
    }>("POST", `/user/${userId}/enrollment`);

    return data;
  }

  async createVehicle(
    input: VehicleInput,
    fuelTypeId: string,
    driverId: string,
    branchId?: string,
  ): Promise<string> {
    await this.api.request("POST", `/vehicle/create-vehicle/${this.b}`, {
      body: {
        description: input.description,
        license_plate: input.plate,
        brand: input.brand,
        model: input.model,
        acquisition_date: "2024-03-01",
        fleet_type: "OWNED",
        current_mileage: input.mileage,
        maintenance_interval_km: 10_000,
        maintenance_interval_months: 6,
        renavam: input.renavam,
        manufacturing_year: "2023",
        model_year: "2024",
        km_per_liter: 9.5,
        number_of_axles: 2,
        status: "ACTIVE",
        fuelTypeId,
        driverId,
        ...(branchId && { branchId }),
      },
    });

    const vehicle = (
      await this.list("/vehicle/list-vehicle", { search: input.plate })
    ).find((row) => row.license_plate === input.plate);

    if (!vehicle) throw new Error(`Veículo ${input.plate} não encontrado.`);

    return vehicle.id;
  }

  async createDelivery(
    input: DeliveryInput,
    shipperId: string,
  ): Promise<string> {
    const { data } = await this.api.request<{ data: { id: string } }>(
      "POST",
      `/delivery/create-delivery/${this.b}`,
      {
        // The same form saved twice is one delivery (IDEMP-14).
        headers: { "Idempotency-Key": randomUUID() },
        body: {
          shipperId,
          kind: "DELIVERY",
          code: input.code,
          invoice_number: input.invoiceNumber,
          recipient_name: input.recipientName,
          recipient_telephone: input.recipientTelephone,
          cep: input.zip,
          city: "São Paulo",
          uf: "SP",
          street: input.street,
          address_number: input.number,
          neighborhood: input.district,
          latitude: input.latitude,
          longitude: input.longitude,
          scheduled_date: input.scheduledDate,
          items: input.items,
        },
      },
    );

    return data.data.id;
  }

  async createRoute(body: {
    driverId: string;
    vehicleId: string;
    name: string;
    scheduledDate: string;
    deliveryIds: string[];
  }): Promise<RouteCreated> {
    const { data } = await this.api.request<{ data: RouteCreated }>(
      "POST",
      `/route/create-route/${this.b}`,
      {
        headers: { "Idempotency-Key": randomUUID() },
        body: {
          driverId: body.driverId,
          vehicleId: body.vehicleId,
          name: body.name,
          destination: "CD Vila Leopoldina",
          scheduled_date: body.scheduledDate,
          deliveryIds: body.deliveryIds,
        },
      },
    );

    return data.data;
  }

  async releaseRoute(
    routeId: string,
    expectedPlanVersion?: number,
  ): Promise<number> {
    const { data } = await this.api.request<{ data: { planVersion: number } }>(
      "PATCH",
      `/route/release-route/${routeId}/business/${this.b}`,
      {
        body: {
          released: true,
          ...(expectedPlanVersion !== undefined && { expectedPlanVersion }),
        },
      },
    );

    return data.data.planVersion;
  }

  async getRoute(routeId: string): Promise<Record<string, any>> {
    const { data } = await this.api.request<{ data: Record<string, any> }>(
      "GET",
      `/route/get-route/${routeId}/business/${this.b}`,
    );

    return data.data;
  }

  /** K12: a delivery onto a route already on the street. */
  async addStops(
    routeId: string,
    deliveryIds: string[],
    expectedPlanVersion?: number,
  ): Promise<{ added: number; stopIds: string[]; planVersion: number }> {
    const { data } = await this.api.request<{
      data: { added: number; stopIds: string[]; planVersion: number };
    }>("POST", `/route/add-stops/${routeId}/business/${this.b}`, {
      body: {
        deliveryIds,
        ...(expectedPlanVersion !== undefined && { expectedPlanVersion }),
      },
    });

    return data.data;
  }

  /** "Cancelar entrega" (the deliveries board): a status override with a reason. */
  async cancelDelivery(
    deliveryId: string,
    reasonId: string,
    note: string,
  ): Promise<void> {
    await this.api.request(
      "PATCH",
      `/delivery/update-delivery-status/${deliveryId}/business/${this.b}`,
      { body: { status: "CANCELLED", reasonId, note } },
    );
  }

  async pendingAuthorizations(): Promise<Array<Record<string, any>>> {
    const { data } = await this.api.request<{
      data: Array<Record<string, any>>;
    }>("GET", `/delivery/occurrence-authorizations?businessId=${this.b}`);

    return data.data;
  }

  async decideAuthorization(
    occurrenceId: string,
    decision: "APPROVED" | "DENIED",
    note?: string,
  ): Promise<Record<string, any>> {
    const { data } = await this.api.request<{ data: Record<string, any> }>(
      "POST",
      `/delivery/occurrence-authorization/${occurrenceId}/business/${this.b}`,
      { body: { decision, ...(note && { note }) } },
    );

    return data.data;
  }

  /** K11: "Encerrar com pendências". */
  async closeWithPending(
    routeId: string,
    reason: string,
  ): Promise<Record<string, any>> {
    const { data } = await this.api.request<{ data: Record<string, any> }>(
      "POST",
      `/route/close-with-pending/${routeId}/business/${this.b}`,
      { body: { reason } },
    );

    return data.data;
  }

  async controlTower(): Promise<Record<string, any>> {
    const { data } = await this.api.request<{ data: Record<string, any> }>(
      "GET",
      `/route/control-tower?businessId=${this.b}`,
    );

    return data.data;
  }

  async getDelivery(deliveryId: string): Promise<Record<string, any>> {
    const { data } = await this.api.request<{ data: Record<string, any> }>(
      "GET",
      `/delivery/get-delivery/${deliveryId}/business/${this.b}`,
    );

    return data.data;
  }

  get logRef(): SimLog {
    return this.log;
  }
}

export { Dispatcher };
export type {
  DeliveryInput,
  DriverAccess,
  DriverInput,
  RouteCreated,
  VehicleInput,
};
