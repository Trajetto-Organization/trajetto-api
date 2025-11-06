import {
  Simulation,
  CreateSimulationProps,
  UpdateSimulationProps,
  ListSimulationsProps,
  ListSimulationsResult,
  SimulationResults,
} from "../dtos/simulation-dto";

interface ISimulationRepository {
  create: (data: CreateSimulationProps) => Promise<Simulation>;
  listByBusiness: (props: ListSimulationsProps) => Promise<ListSimulationsResult>;
  findById: (id: string) => Promise<Simulation | null>;
  findByBusinessAndId: (
    simulationId: string,
    businessId: string
  ) => Promise<Simulation | null>;
  update: (props: UpdateSimulationProps) => Promise<Simulation>;
  delete: (id: string) => Promise<Simulation>;
  updateStatus: (id: string, status: string) => Promise<Simulation>;
  updateResults: (
    id: string,
    results: SimulationResults
  ) => Promise<Simulation>;
  countByBusiness: (businessId: string) => Promise<number>;
  findByStatus: (status: string, businessId?: string) => Promise<Simulation[]>;
}

export { ISimulationRepository };
