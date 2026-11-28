# reconnect-storm — Tempestade de reconexão

**Quando:** depois de um deploy ou de uma queda de rede, todos os sockets voltam juntos.

## O que significa

Os apps dos motoristas e os painéis reconectam o Socket.IO ao mesmo tempo: picos de handshake, de CPU e de laço de eventos nas réplicas que sobraram. O limitador do handshake segura a fila; o SLO é 99% dos sockets de volta em até 60 s.

## Primeira ação

1. Acompanhe `runtime` em `/health/metrics` (ELU e atraso do laço) e as linhas do `ops_sample` do minuto.
2. Espere um ou dois minutos: a reconexão tem espera crescente nos clientes.
3. Não dê outro Deploy no meio: ele começa outra tempestade.

## Como confirmar

O número de sockets em `/health/metrics` estabiliza e a ELU volta abaixo de 0,7.

## Quando escalar

CPU no teto por mais de 5 minutos, ou a API respondendo 503: chame o dono.
