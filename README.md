# 🚛 Trajetto - Sistema de Gestão de Frotas

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?style=for-the-badge&logo=fastify&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![RabbitMQ](https://img.shields.io/badge/RabbitMQ-FF6600?style=for-the-badge&logo=rabbitmq&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)

**Sistema completo de gestão de frotas com funcionalidades avançadas de controle, manutenção e monitoramento de veículos**

[🚀 Começar](#-instalação) • [📚 Documentação](#-documentação) • [🏗️ Arquitetura](#️-arquitetura) • [🧪 Testes](#-testes)

</div>

---

## 📋 Índice

- [Sobre o Projeto](#-sobre-o-projeto)
- [Funcionalidades](#-funcionalidades)
- [Tecnologias](#-tecnologias)
- [Pré-requisitos](#-pré-requisitos)
- [Instalação](#-instalação)
- [Configuração](#-configuração)
- [Uso](#-uso)
- [Arquitetura](#️-arquitetura)
- [API Documentation](#-api-documentation)
- [Testes](#-testes)
- [Deploy](#-deploy)
- [Contribuição](#-contribuição)
- [Licença](#-licença)

## 🎯 Sobre o Projeto

O **Trajetto** é uma solução completa para gestão de frotas empresariais, desenvolvido com foco em escalabilidade, performance e facilidade de uso. O sistema oferece controle total sobre veículos, motoristas, manutenções, custos e compliance regulatório.

### ✨ Diferenciais

- **🏢 Multi-tenant**: Suporte completo para múltiplas empresas e filiais
- **🔐 Segurança Avançada**: Autenticação JWT + 2FA, controle granular de permissões
- **📊 Analytics em Tempo Real**: Dashboard completo com métricas e indicadores
- **🔔 Notificações Inteligentes**: Sistema de alertas via WebSocket e email
- **📱 API RESTful**: Documentação completa com Swagger/OpenAPI
- **🐳 Cloud Ready**: Containerizado com Docker e orquestração

## 🚀 Funcionalidades

### 👥 Gestão de Usuários e Permissões

- Sistema de autenticação com JWT e refresh tokens
- Autenticação de dois fatores (2FA) por email
- Controle granular de permissões por módulo
- Perfis de acesso personalizáveis por empresa
- Gestão de sessões e revogação de acesso

### 🏢 Gestão Empresarial

- Cadastro de empresas e filiais
- Estrutura hierárquica multi-tenant
- Gestão de fornecedores e parceiros
- Controle de dados fiscais e regulatórios

### 🚛 Gestão de Frota

- Cadastro completo de veículos com histórico
- Categorização por tipos e combustíveis
- Controle de propriedade (próprio/terceirizado)
- Status em tempo real (ativo, em rota, manutenção)
- Gestão de documentação e vencimentos

### 👨‍✈️ Gestão de Motoristas

- Cadastro completo com documentação
- Controle de CNH e vencimentos
- Histórico de infrações e penalidades
- Gestão de contratos (próprio/terceirizado)

### 🔧 Manutenção e Ordens de Serviço

- Criação e acompanhamento de ordens de serviço
- Controle de peças e materiais utilizados
- Gestão de fornecedores de serviços
- Histórico completo de manutenções
- Alertas de manutenção preventiva

### 💰 Gestão Financeira

- Contas a pagar com controle de vencimentos
- Análise de custos por veículo/motorista
- Relatórios financeiros detalhados
- Controle de orçamentos e centros de custo

### 🚨 Gestão de Multas e Infrações

- Importação automática de códigos DETRAN
- Registro e acompanhamento de multas
- Controle de pontuação na CNH
- Relatórios de compliance

### 📊 Dashboard e Relatórios

- Métricas em tempo real da frota
- Análise de custos e performance
- Indicadores de manutenção
- Gráficos e visualizações interativas

### 🔔 Sistema de Notificações

- Notificações em tempo real via WebSocket
- Alertas por email com templates personalizados
- Notificações push para eventos importantes
- Centro de notificações integrado

### 📋 Sistema Kanban

- Organização visual de tarefas
- Gestão de projetos e atividades
- Colaboração em equipe
- Acompanhamento de progresso

## 🛠 Tecnologias

### Backend Core

- **[Node.js](https://nodejs.org/)** - Runtime JavaScript
- **[TypeScript](https://www.typescriptlang.org/)** - Superset tipado do JavaScript
- **[Fastify](https://www.fastify.io/)** - Framework web rápido e eficiente
- **[Prisma ORM](https://www.prisma.io/)** - ORM moderno para TypeScript

### Banco de Dados

- **[PostgreSQL](https://www.postgresql.org/)** - Banco de dados relacional
- **[RabbitMQ](https://www.rabbitmq.com/)** - Message broker para filas

### Autenticação e Segurança

- **[JWT](https://jwt.io/)** - JSON Web Tokens
- **[bcrypt](https://www.npmjs.com/package/bcrypt)** - Hash de senhas
- **[Helmet](https://helmetjs.github.io/)** - Middleware de segurança

### Comunicação em Tempo Real

- **[Socket.IO](https://socket.io/)** - WebSocket para tempo real
- **[Nodemailer](https://nodemailer.com/)** - Envio de emails

### Infraestrutura e DevOps

- **[Docker](https://www.docker.com/)** - Containerização
- **[Docker Compose](https://docs.docker.com/compose/)** - Orquestração local
- **[GitHub Actions](https://github.com/features/actions)** - CI/CD

### Documentação e Testes

- **[Swagger/OpenAPI](https://swagger.io/)** - Documentação da API
- **[Vitest](https://vitest.dev/)** - Framework de testes
- **[Supertest](https://www.npmjs.com/package/supertest)** - Testes de API

### Qualidade de Código

- **[ESLint](https://eslint.org/)** - Linter para JavaScript/TypeScript
- **[Prettier](https://prettier.io/)** - Formatador de código
- **[Husky](https://typicode.github.io/husky/)** - Git hooks

## 📋 Pré-requisitos

Antes de começar, você precisa ter instalado em sua máquina:

- [Node.js](https://nodejs.org/) (versão 18 ou superior)
- [Docker](https://www.docker.com/) e [Docker Compose](https://docs.docker.com/compose/)
- [Git](https://git-scm.com/)
- [Yarn](https://yarnpkg.com/) (recomendado) ou npm

## 🚀 Instalação

### 1. Clone o repositório

```bash
git clone https://github.com/seu-usuario/trajetto-api.git
cd trajetto-api
```

### 2. Instale as dependências

```bash
yarn install
# ou
npm install
```

### 3. Configure as variáveis de ambiente

```bash
# Copie o arquivo de exemplo
cp .env.development.example .env.development

# Edite o arquivo com suas configurações
nano .env.development
```

### 4. Inicie os serviços com Docker

```bash
# Inicia PostgreSQL e RabbitMQ
yarn services:up
```

### 5. Execute as migrações do banco

```bash
# Gera o cliente Prisma e executa migrações
yarn prisma:generate
yarn prisma:migrate:dev
```

### 6. Execute o seed do banco

```bash
# Cria usuário master e importa códigos de infração
yarn seed
yarn seed:infringement
```

### 7. Inicie o servidor de desenvolvimento

```bash
yarn dev
```

A API estará disponível em `http://localhost:3333`

## ⚙️ Configuração

### Variáveis de Ambiente

O projeto utiliza diferentes arquivos de ambiente:

- `.env.development` - Desenvolvimento local
- `.env.test` - Ambiente de testes
- `.env.production` - Produção

#### Principais variáveis:

```bash
# Banco de dados
DATABASE_URL="postgresql://user:password@localhost:5432/database"

# RabbitMQ
RABBITMQ_URL="amqp://user:password@localhost:5672"

# Autenticação JWT
JWT_SECRET="seu-jwt-secret-seguro"
JWT_SECRET_REFRESH_TOKEN="seu-refresh-token-secret"

# Email (Resend em produção)
RESEND_SECRET_KEY="sua-api-key-resend"
RESEND_FROM_EMAIL="noreply@seudominio.com"

# Usuário Master
MASTER_USER_EMAIL="admin@trajetto.com"
MASTER_USER_INITIAL_PASSWORD="SenhaSegura123@"

# HTTP
HTTP_REQUEST="http://localhost:3000"
```

### Docker Compose

O projeto inclui configurações para desenvolvimento e produção:

```bash
# Desenvolvimento
docker-compose up -d

# Produção
docker-compose -f compose.deploy.yaml up -d
```

## 🎮 Uso

### Autenticação

1. **Login inicial**:

```bash
POST /user/session
{
  "email": "admin@trajetto.com",
  "password": "SenhaSegura123@"
}
```

2. **Usar o token retornado** em todas as requisições:

```bash
Authorization: Bearer seu-jwt-token
```

### Principais Endpoints

#### Usuários

```bash
POST /user/create-user          # Criar usuário
GET  /user/list-users           # Listar usuários
GET  /user/me                   # Perfil do usuário logado
PATCH /user/password            # Alterar senha
```

#### Empresas

```bash
POST /business/create-business  # Criar empresa
GET  /business/list-business    # Listar empresas
PATCH /business/update-business/:id # Atualizar empresa
```

#### Veículos

```bash
POST /vehicle/create-vehicle/:businessId    # Criar veículo
GET  /vehicle/list-vehicle                  # Listar veículos
PATCH /vehicle/update-vehicle/:id/business/:businessId # Atualizar veículo
```

#### Ordens de Serviço

```bash
POST /service-order/create-service-order/:businessId # Criar OS
GET  /service-order/list-service-order              # Listar OS
```

### Documentação Interativa

Acesse a documentação Swagger em: `http://localhost:3333/docs`

### WebSocket

Conecte-se ao WebSocket para notificações em tempo real:

```javascript
import io from "socket.io-client";

const socket = io("http://localhost:3333", {
  auth: {
    token: "seu-jwt-token",
  },
});

socket.on("pushNotification", (notification) => {
  console.log("Nova notificação:", notification);
});
```

## 🏗️ Arquitetura

### Estrutura do Projeto

```
src/
├── @types/           # Definições de tipos TypeScript
├── config/           # Configurações da aplicação
├── env/              # Validação de variáveis de ambiente
├── jobs/             # Jobs e filas (RabbitMQ)
├── modules/          # Módulos da aplicação
│   ├── user/         # Módulo de usuários
│   │   ├── dtos/     # Data Transfer Objects
│   │   ├── repositories/ # Camada de dados
│   │   └── usecases/ # Casos de uso (regras de negócio)
│   ├── vehicle/      # Módulo de veículos
│   ├── business/     # Módulo de empresas
│   └── ...
├── routes/           # Definição de rotas da API
├── services/         # Serviços compartilhados
├── shared/           # Código compartilhado
├── websocket.ts      # Configuração WebSocket
└── workers/          # Workers para processamento assíncrono
```

### Princípios Arquiteturais

#### Clean Architecture + DDD

- **Entities**: Regras de negócio fundamentais
- **Use Cases**: Casos de uso da aplicação
- **Repositories**: Abstração da camada de dados
- **Controllers**: Adaptadores para entrada HTTP

#### SOLID Principles

- **S**ingle Responsibility
- **O**pen/Closed
- **L**iskov Substitution
- **I**nterface Segregation
- **D**ependency Inversion

#### Design Patterns

- **Repository Pattern**: Abstração do acesso a dados
- **Dependency Injection**: Inversão de controle com TSyringe
- **Observer Pattern**: Notificações e eventos
- **Strategy Pattern**: Diferentes provedores (email, storage)

### Fluxo de Dados

```mermaid
graph TD
    A[HTTP Request] --> B[Route Handler]
    B --> C[Controller]
    C --> D[Use Case]
    D --> E[Repository]
    E --> F[Database/Prisma]
    D --> G[External Services]
    D --> H[Event Dispatcher]
    H --> I[Notification Service]
    I --> J[Email Queue]
    I --> K[WebSocket]
```

## 📚 API Documentation

### Swagger/OpenAPI

A documentação completa da API está disponível em `/docs` quando o servidor está rodando.

### Esquemas de Validação

Todas as rotas utilizam validação com Zod:

```typescript
const createUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["MASTER", "BUSINESS_ADMIN", "BUSINESS_USER"]),
});
```

### Rate Limiting

Proteção contra abuso com rate limiting:

```typescript
// Login: máximo 8 tentativas por minuto
// Cadastro: máximo 20 por minuto
// Forgot Password: máximo 4 por minuto
```

### Paginação

Resposta padrão para listagens:

```json
{
  "data": [],
  "total": 100,
  "page": 1,
  "pageSize": 10,
  "totalPages": 10
}
```

## 🧪 Testes

### Estrutura de Testes

```
tests/
├── E2E/              # Testes end-to-end
├── unitaires/        # Testes unitários
└── utils/            # Utilitários para testes
```

### Executar Testes

```bash
# Testes unitários
yarn test

# Testes unitários em modo watch
yarn test:watch

# Testes E2E
yarn test:e2e

# Cobertura de testes
yarn test:coverage

# Interface visual dos testes
yarn test:ui
```

### Ambiente de Teste

Os testes E2E utilizam um ambiente Prisma isolado:

```typescript
// Cada teste roda em um schema único
// Cleanup automático após execução
// Dados de seed específicos para testes
```

### Exemplo de Teste

```typescript
describe("Create User Use Case", () => {
  it("should create a new user", async () => {
    const userData = {
      name: "John Doe",
      email: "john@example.com",
      password: "12345678",
      role: "BUSINESS_USER",
    };

    const user = await createUserUseCase.execute(userData);

    expect(user).toHaveProperty("id");
    expect(user.email).toBe(userData.email);
  });
});
```

## 🚀 Deploy

### Produção com Docker

#### 1. Build da imagem

```bash
# Build da imagem de produção
docker build -t trajetto-api .
```

#### 2. Deploy com docker-compose

```bash
# Produção
docker-compose -f compose.deploy.yaml up -d
```

### CI/CD com GitHub Actions

O projeto inclui pipeline completa de CI/CD:

```yaml
# .github/workflows/deploy.yml
# - Build automático
# - Testes
# - Push para Docker Hub
# - Deploy automático
```

### Variáveis de Ambiente (Produção)

```bash
# Configure no seu provedor de cloud
DATABASE_URL="postgresql://..."
RABBITMQ_URL="amqp://..."
JWT_SECRET="production-secret"
RESEND_SECRET_KEY="re_..."
```

### Health Checks

A aplicação inclui endpoints de saúde:

```bash
GET /health          # Status completo
GET /health/liveness # Aplicação respondendo
GET /health/readiness # Pronto para receber tráfego
```

### Monitoramento

#### Logs Estruturados

```typescript
console.log({
  level: "info",
  service: "trajetto-api",
  message: "User created",
  userId: "123",
  timestamp: new Date().toISOString(),
});
```

#### Métricas

- Response time
- Error rates
- Database connections
- Queue lengths

## 📊 Performance

### Otimizações Implementadas

- **Database**: Índices otimizados, connection pooling
- **API**: Rate limiting, compression, caching
- **Workers**: Processamento assíncrono com RabbitMQ
- **Memory**: Singleton patterns, garbage collection tuning

### Benchmarks

```bash
# Exemplo de performance
GET /vehicle/list-vehicle
- Média: 150ms
- P95: 300ms
- P99: 500ms
```

## 🤝 Contribuição

### Como Contribuir

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

### Padrões de Código

#### Commits Semânticos

```bash
feat: add new vehicle registration feature
fix: resolve authentication token expiry issue
docs: update API documentation
test: add unit tests for user service
refactor: optimize database queries
```

#### Code Style

- Use Prettier para formatação
- ESLint para linting
- Nomeação em inglês
- Interfaces com prefixo `I`
- DTOs com sufixo `Props`

### Code Review

- Pelo menos 1 aprovação necessária
- Testes devem passar
- Cobertura mínima de 80%
- Documentação atualizada

## 🔐 Segurança

### Medidas Implementadas

- **Autenticação**: JWT + Refresh Tokens
- **2FA**: Verificação por email
- **Rate Limiting**: Proteção contra brute force
- **Helmet**: Headers de segurança
- **Validation**: Sanitização de inputs
- **CORS**: Configurado para dominios específicos

### Vulnerabilidades Conhecidas

Execute regularmente:

```bash
# Auditoria de dependências
yarn audit

# Verificação de segurança
npm audit fix
```

## 🐛 Troubleshooting

### Problemas Comuns

#### Database Connection Error

```bash
# Verifique se o PostgreSQL está rodando
docker-compose ps

# Recrie o banco se necessário
yarn prisma:migrate:reset
```

#### RabbitMQ Connection Failed

```bash
# Verifique os logs do RabbitMQ
docker-compose logs rabbitmq

# Reinicie o serviço
docker-compose restart rabbitmq
```

#### Port Already in Use

```bash
# Encontre o processo usando a porta
lsof -i :3333

# Mate o processo
kill -9 PID
```

### Logs de Debug

Ative logs detalhados:

```bash
# Desenvolvimento
NODE_ENV=development DEBUG=* yarn dev

# Apenas logs da aplicação
DEBUG=trajetto:* yarn dev
```

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

---

<div align="center">

**Desenvolvido com ❤️ pela equipe Trajetto**

[Website](https://www.intrajetto.com) • [Documentação](https://docs.trajetto.com) • [Suporte](mailto:contato@trajetto.com)

</div>
