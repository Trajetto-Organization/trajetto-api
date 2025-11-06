type PermissionKey =
  | "branch_manage"
  | "profile_access_manage"
  | "user_permission_manage"
  | "user_registration_manage"
  | "vehicle_type_manage"
  | "supplier_manage"
  | "fuel_type_manage"
  | "fuel_manage"
  | "part_manage"
  | "driver_manage"
  | "vehicle_manage"
  | "service_order_manage"
  | "service_order_part_manage"
  | "account_payable_manage"
  | "kanban_manage"
  | "fine_manage"
  | "route_manage"
  | "simulation_manage";

enum EnumPermissionKey {
  BRANCH_MANAGE = "branch_manage",
  PROFILE_ACCESS_MANAGE = "profile_access_manage",
  USER_PERMISSION_MANAGE = "user_permission_manage",
  USER_REGISTRATION_MANAGE = "user_registration_manage",
  VEHICLE_TYPE_MANAGE = "vehicle_type_manage",
  SUPPLIER_MANAGE = "supplier_manage",
  FUEL_TYPE_MANAGE = "fuel_type_manage",
  FUEL_MANAGE = "fuel_manage",
  PART_MANAGE = "part_manage",
  DRIVER_MANAGE = "driver_manage",
  VEHICLE_MANAGE = "vehicle_manage",
  SERVICE_ORDER_MANAGE = "service_order_manage",
  SERVICE_ORDER_PART_MANAGE = "service_order_part_manage",
  ACCOUNT_PAYABLE_MANAGE = "account_payable_manage",
  KANBAN_MANAGE = "kanban_manage",
  FINE_MANAGE = "fine_manage",
  ROUTE_MANAGE = "route_manage",
  SIMULATION_MANAGE = "simulation_manage",
}

const permissionLabels = {
  branch_manage: "Gerenciar Filiais",
  profile_access_manage: "Gerenciar Perfis de Acesso",
  user_permission_manage: "Gerenciar Permissões",
  user_registration_manage: "Gerenciar Cadastro de Usuários",
  vehicle_type_manage: "Gerenciar tipos de veículos",
  supplier_manage: "Gerenciar Fornecedores",
  fuel_type_manage: "Gerenciar tipos de combustíveis",
  fuel_manage: "Gerenciar Abastecimentos",
  part_manage: "Gerenciar Peças",
  driver_manage: "Gerenciar Motoristas",
  vehicle_manage: "Gerenciar Veículos",
  service_order_manage: "Gerenciar Ordens de Serviço",
  service_order_part_manage: "Gerenciar Ordens de Serviço Por Peça",
  account_payable_manage: "Gerenciar Contas a Pagar",
  kanban_manage: "Gerenciar Kanban",
  fine_manage: "Gerenciar Multas",
  route_manage: "Gerenciar Rotas",
  simulation_manage: "Gerenciar Simulações de Rotas",
};

export { PermissionKey, EnumPermissionKey, permissionLabels };
