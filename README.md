# SICOR — Sistema Integrado de Corregedoria

Bot próprio para Discord, com central de atendimento, protocolos, painel interno, acompanhamento, status, evidências complementares e registro de movimentações.

## Importante
Esta é uma primeira versão funcional para testes. Antes de usar com casos reais, faça testes em um servidor de teste e revise as permissões e os procedimentos internos. Não publique o token do bot. O arquivo `.env` nunca deve ser enviado ao GitHub.

## Requisitos
- Node.js 22 ou superior
- Uma aplicação/bot no Discord Developer Portal
- Um servidor Discord de teste
- Um canal privado para processos
- Dois cargos: Corregedor e Alto-Comando da Polícia Civil

## Configuração
1. Baixe/descompacte este projeto.
2. Copie `.env.example` para `.env`.
3. Preencha `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `INTERNAL_CHANNEL_ID`, `CORREGEDOR_ROLE_ID` e `ALTO_COMANDO_ROLE_ID`.
4. Opcionalmente preencha `AUDIT_CHANNEL_ID`.
5. Instale dependências com `npm install`.
6. Inicie com `npm start`.

## Primeiros passos no Discord
- Convide o bot para o servidor com os escopos `bot` e `applications.commands`.
- Dê permissões para enviar mensagens, incorporar links e usar comandos de aplicação.
- Use `/sicor-publicar-painel` no canal público escolhido.
- O bot registrará processos no canal configurado em `INTERNAL_CHANNEL_ID`.

## Variáveis
Veja `.env.example`.

## Limitações conhecidas desta primeira versão
- Formulários usam campos de texto; uploads de arquivos podem ser enviados como links complementares.
- A notificação privada pode falhar se o usuário bloquear DMs do bot.
- O banco SQLite fica em `data/sicor.sqlite`; a hospedagem deve preservar o diretório `data`.
- As decisões finais são restritas ao cargo Alto-Comando nesta versão inicial.
- Faça backup periódico do arquivo de banco de dados.
- Antes de uso real, revisar permissões, retenção de dados e processo de recurso/decisão.
