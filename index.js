require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits
} = require("discord.js");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "INTERNAL_CHANNEL_ID", "CORREGEDOR_ROLE_ID", "ALTO_COMANDO_ROLE_ID"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error("Faltam variáveis no .env:", missing.join(", "));
  process.exit(1);
}

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "sicor.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT UNIQUE,
  kind TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  requester_tag TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Recebido',
  assigned_to TEXT DEFAULT '',
  decision TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(case_id) REFERENCES cases(id)
);
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

const COLORS = { black: 0x151515, gold: 0xC6A64B, white: 0xF4F4F4 };
const now = () => new Date().toISOString();
const protocolFor = (id) => `COR-${new Date().getFullYear()}-${String(id).padStart(4, "0")}`;
const escapeText = (s, max = 1000) => String(s || "").slice(0, max);
const isStaff = (member) => Boolean(member?.roles?.cache?.has(process.env.CORREGEDOR_ROLE_ID) || member?.roles?.cache?.has(process.env.ALTO_COMANDO_ROLE_ID));
const isHighCommand = (member) => Boolean(member?.roles?.cache?.has(process.env.ALTO_COMANDO_ROLE_ID));

function caseEmbed(c, title = "SICOR | Processo") {
  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`⚖️ ${title}`)
    .setDescription(`**Protocolo:** \`${c.protocol}\`\n**Natureza:** ${c.kind}\n**Status:** ${c.status}`)
    .addFields(
      { name: "Solicitante", value: `<@${c.requester_id}>`, inline: true },
      { name: "Responsável", value: c.assigned_to ? `<@${c.assigned_to}>` : "Aguardando responsável", inline: true },
      { name: "Identificação / assunto", value: escapeText(c.subject, 500) || "Não informado" },
      { name: "Relato", value: escapeText(c.description, 1000) || "Não informado" },
      { name: "Evidências / links", value: escapeText(c.evidence, 1000) || "Nenhuma informada" }
    )
    .setFooter({ text: "SICOR • Sistema Integrado de Corregedoria" })
    .setTimestamp(new Date(c.created_at));
}

function staffButtons(protocol) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sicor:claim:${protocol}`).setLabel("Assumir").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sicor:status:${protocol}`).setLabel("Atualizar status").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sicor:requestevidence:${protocol}`).setLabel("Solicitar evidências").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sicor:message:${protocol}`).setLabel("Enviar mensagem").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sicor:decision:${protocol}`).setLabel("Registrar decisão").setStyle(ButtonStyle.Danger)
  );
}

function publicPanel() {
  const embed = new EmbedBuilder()
    .setColor(COLORS.black)
    .setTitle("⚖️ SICOR | Central de Corregedoria")
    .setDescription(
      "Bem-vindo à Central de Corregedoria da Polícia Civil.\n\n" +
      "Utilize os botões abaixo para registrar uma solicitação ou consultar um processo. Cada registro recebe um protocolo individual.\n\n" +
      "⚠️ Forneça informações verdadeiras. Não envie dados pessoais desnecessários. O protocolo não substitui a verificação de identidade."
    )
    .addFields({ name: "Serviços disponíveis", value: "🔴 Registrar denúncia\n🟠 Recorrer de punição\n🔵 Retirar dúvidas\n🟣 Enviar evidências complementares\n🟢 Acompanhar processo" })
    .setFooter({ text: "SICOR • Preto, branco e dourado" });
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sicor:new:Denúncia").setLabel("Registrar denúncia").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sicor:new:Recurso disciplinar").setLabel("Recorrer de punição").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("sicor:new:Dúvida").setLabel("Retirar dúvidas").setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sicor:evidence").setLabel("Enviar evidências").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("sicor:track").setLabel("Acompanhar processo").setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row1, row2] };
}

function logEvent(caseId, actorId, type, details) {
  db.prepare("INSERT INTO events (case_id, actor_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(caseId, actorId, type, details, now());
}

async function sendAudit(guild, text) {
  const id = process.env.AUDIT_CHANNEL_ID;
  if (!id) return;
  const channel = await guild.channels.fetch(id).catch(() => null);
  if (channel?.isTextBased()) await channel.send({ content: text }).catch(() => {});
}

async function notifyRequester(userId, message) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  return user.send(message).then(() => true).catch(() => false);
}

function modalText(customId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  modal.addComponents(...fields.map((f) => {
    const input = new TextInputBuilder()
      .setCustomId(f.id).setLabel(f.label).setStyle(f.style || TextInputStyle.Short)
      .setRequired(f.required !== false).setMaxLength(f.max || 1000);
    if (f.placeholder) input.setPlaceholder(f.placeholder);
    if (f.value) input.setValue(f.value);
    return new ActionRowBuilder().addComponents(input);
  }));
  return modal;
}

const commands = [
  new SlashCommandBuilder().setName("sicor-ajuda").setDescription("Mostra os comandos básicos do SICOR."),
  new SlashCommandBuilder().setName("sicor-publicar-painel").setDescription("Publica a central de atendimento neste canal.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("sicor-processo").setDescription("Consulta um processo (a equipe pode consultar qualquer processo).")
    .addStringOption(o => o.setName("protocolo").setDescription("Ex.: COR-2026-0001").setRequired(true)),
  new SlashCommandBuilder().setName("sicor-meus-processos").setDescription("Lista seus processos recentes."),
  new SlashCommandBuilder().setName("sicor-relatorio").setDescription("Mostra um resumo de processos (equipe autorizada).")
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands.map(c => c.toJSON()) });
  console.log("Comandos SICOR registrados no servidor configurado.");
}

client.once("ready", () => {
  console.log(`SICOR conectado como ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "sicor-ajuda") {
        return interaction.reply({ ephemeral: true, content: "**SICOR — Ajuda**\nUse `/sicor-publicar-painel` para publicar a central (gestores), `/sicor-meus-processos` para consultar seus registros e `/sicor-processo` com um protocolo válido." });
      }
      if (interaction.commandName === "sicor-publicar-painel") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Você não tem permissão para publicar o painel.", ephemeral: true });
        await interaction.channel.send(publicPanel());
        return interaction.reply({ content: "Central SICOR publicada neste canal.", ephemeral: true });
      }
      if (interaction.commandName === "sicor-meus-processos") {
        const rows = db.prepare("SELECT protocol, kind, status, updated_at FROM cases WHERE requester_id = ? ORDER BY id DESC LIMIT 10").all(interaction.user.id);
        if (!rows.length) return interaction.reply({ content: "Você ainda não possui processos registrados.", ephemeral: true });
        return interaction.reply({ content: rows.map(c => `**${c.protocol}** • ${c.kind} • **${c.status}** • atualizado ${c.updated_at.slice(0,16).replace("T"," ")} UTC`).join("\n"), ephemeral: true });
      }
      if (interaction.commandName === "sicor-processo") {
        const protocol = interaction.options.getString("protocolo", true).toUpperCase().trim();
        const c = db.prepare("SELECT * FROM cases WHERE protocol = ?").get(protocol);
        if (!c) return interaction.reply({ content: "Não encontrei esse protocolo.", ephemeral: true });
        if (c.requester_id !== interaction.user.id && !isStaff(interaction.member)) return interaction.reply({ content: "Você não tem autorização para consultar esse processo.", ephemeral: true });
        return interaction.reply({ embeds: [caseEmbed(c, "Consulta de processo")], ephemeral: true });
      }
      if (interaction.commandName === "sicor-relatorio") {
        if (!isStaff(interaction.member)) return interaction.reply({ content: "Comando restrito à Corregedoria e ao Alto-Comando.", ephemeral: true });
        const stats = db.prepare("SELECT status, COUNT(*) AS total FROM cases GROUP BY status").all();
        const total = db.prepare("SELECT COUNT(*) AS n FROM cases").get().n;
        return interaction.reply({ content: `**SICOR | Relatório geral**\nTotal de processos: **${total}**\n${stats.map(s => `• ${s.status}: ${s.total}`).join("\n") || "Nenhum processo registrado."}`, ephemeral: true });
      }
    }

    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) return;

    if (interaction.isButton()) {
      const [prefix, action, ...parts] = interaction.customId.split(":");
      if (prefix !== "sicor") return;

      if (action === "new") {
        const kind = parts.join(":");
        const fields = kind === "Denúncia" ? [
          { id: "subject", label: "Denunciado / identificação", placeholder: "Nome ou ID no jogo", max: 100 },
          { id: "unit", label: "Corporação / setor", placeholder: "Se souber, informe", required: false, max: 100 },
          { id: "description", label: "Relato dos fatos", style: TextInputStyle.Paragraph, max: 1000 },
          { id: "when", label: "Data/horário aproximado", required: false, max: 100 },
          { id: "evidence", label: "Links de evidências", required: false, max: 500 }
        ] : kind === "Recurso disciplinar" ? [
          { id: "subject", label: "Punição e responsável", placeholder: "Tipo de punição / responsável", max: 150 },
          { id: "unit", label: "Data da punição", required: false, max: 100 },
          { id: "description", label: "Por que solicita revisão?", style: TextInputStyle.Paragraph, max: 1000 },
          { id: "when", label: "Informações adicionais", required: false, max: 300 },
          { id: "evidence", label: "Links de evidências", required: false, max: 500 }
        ] : [
          { id: "subject", label: "Assunto da dúvida", max: 150 },
          { id: "unit", label: "Área / regulamento", required: false, max: 100 },
          { id: "description", label: "Descreva sua dúvida", style: TextInputStyle.Paragraph, max: 1000 },
          { id: "when", label: "Informações adicionais", required: false, max: 300 },
          { id: "evidence", label: "Link (opcional)", required: false, max: 500 }
        ];
        return interaction.showModal(modalText(`sicor:submit:${kind}`, kind.slice(0,45), fields));
      }

      if (action === "track" || action === "evidence") {
        const isEvidence = action === "evidence";
        const fields = isEvidence ? [
          { id: "protocol", label: "Protocolo do processo", placeholder: "COR-2026-0001", max: 30 },
          { id: "evidence", label: "Links / descrição das novas evidências", style: TextInputStyle.Paragraph, max: 1000 }
        ] : [
          { id: "protocol", label: "Protocolo do processo", placeholder: "COR-2026-0001", max: 30 }
        ];
        return interaction.showModal(modalText(isEvidence ? "sicor:addevidence" : "sicor:lookup", isEvidence ? "Enviar evidências" : "Acompanhar processo", fields));
      }

      const protocol = parts.join(":");
      const c = db.prepare("SELECT * FROM cases WHERE protocol = ?").get(protocol);
      if (!c) return interaction.reply({ content: "Processo não encontrado.", ephemeral: true });
      if (!isStaff(interaction.member)) return interaction.reply({ content: "Acesso restrito aos corregedores autorizados e ao Alto-Comando.", ephemeral: true });

      if (action === "claim") {
        if (c.assigned_to && c.assigned_to !== interaction.user.id && !isHighCommand(interaction.member)) {
          return interaction.reply({ content: `Este processo já foi assumido por <@${c.assigned_to}>. Apenas o Alto-Comando pode transferir a responsabilidade.`, ephemeral: true });
        }
        db.prepare("UPDATE cases SET assigned_to = ?, status = ?, updated_at = ? WHERE id = ?").run(interaction.user.id, "Em investigação", now(), c.id);
        logEvent(c.id, interaction.user.id, "ASSUMIU", "Processo assumido; status atualizado para Em investigação.");
        const updated = db.prepare("SELECT * FROM cases WHERE id = ?").get(c.id);
        await interaction.message.edit({ embeds: [caseEmbed(updated)], components: [staffButtons(protocol)] });
        await notifyRequester(c.requester_id, `⚖️ **SICOR — Atualização de processo**\nSeu processo **${protocol}** foi assumido pela corregedoria e está **Em investigação**.`);
        return interaction.reply({ content: `Você assumiu o processo ${protocol}.`, ephemeral: true });
      }

      if (action === "status") {
        const menu = new StringSelectMenuBuilder().setCustomId(`sicor:statuspick:${protocol}`).setPlaceholder("Selecione o novo status").addOptions(
          { label: "Em investigação", value: "Em investigação" },
          { label: "Em análise", value: "Em análise" },
          { label: "Aguardando evidências", value: "Aguardando evidências" },
          { label: "Aguardando decisão", value: "Aguardando decisão" },
          { label: "Decidido", value: "Decidido" },
          { label: "Encerrado", value: "Encerrado" },
          { label: "Arquivado", value: "Arquivado" }
        );
        return interaction.reply({ content: `Atualizar status de **${protocol}**:`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (action === "requestevidence" || action === "message" || action === "decision") {
        const config = action === "requestevidence"
          ? { title: "Solicitar evidências", id: "sicor:staffform:requestevidence:" + protocol, label: "O que precisa ser enviado?", field: "Mensagem ao solicitante" }
          : action === "message"
          ? { title: "Enviar mensagem", id: "sicor:staffform:message:" + protocol, label: "Mensagem ao solicitante", field: "Mensagem" }
          : { title: "Registrar decisão", id: "sicor:staffform:decision:" + protocol, label: "Decisão e justificativa", field: "Decisão / justificativa" };
        return interaction.showModal(modalText(config.id, config.title, [
          { id: "text", label: config.label, style: TextInputStyle.Paragraph, max: 1000 }
        ]));
      }
    }

    if (interaction.isStringSelectMenu()) {
      const [prefix, action, ...parts] = interaction.customId.split(":");
      if (prefix !== "sicor" || action !== "statuspick") return;
      if (!isStaff(interaction.member)) return interaction.reply({ content: "Acesso restrito.", ephemeral: true });
      const protocol = parts.join(":");
      const c = db.prepare("SELECT * FROM cases WHERE protocol = ?").get(protocol);
      if (!c) return interaction.reply({ content: "Processo não encontrado.", ephemeral: true });
      const status = interaction.values[0];
      db.prepare("UPDATE cases SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), c.id);
      logEvent(c.id, interaction.user.id, "STATUS", `Status alterado para ${status}.`);
      const updated = db.prepare("SELECT * FROM cases WHERE id = ?").get(c.id);
      await interaction.message.edit({ content: `Status de ${protocol} atualizado para **${status}**.`, components: [] });
      await notifyRequester(c.requester_id, `⚖️ **SICOR — Atualização de processo**\nProtocolo: **${protocol}**\nNovo status: **${status}**`);
      await sendAudit(interaction.guild, `SICOR | ${protocol}: status alterado para ${status} por <@${interaction.user.id}>.`);
      return interaction.reply({ content: "Status atualizado e solicitante notificado quando possível.", ephemeral: true });
    }

    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      if (id.startsWith("sicor:submit:")) {
        const kind = id.slice("sicor:submit:".length);
        const subject = interaction.fields.getTextInputValue("subject");
        const unit = interaction.fields.getTextInputValue("unit");
        const description = interaction.fields.getTextInputValue("description");
        const when = interaction.fields.getTextInputValue("when");
        const evidence = interaction.fields.getTextInputValue("evidence");
        const created = now();
        const info = [unit ? `Setor: ${unit}` : "", when ? `Data/horário: ${when}` : ""].filter(Boolean).join("\n");
        const result = db.prepare("INSERT INTO cases (kind, requester_id, requester_tag, subject, description, evidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(kind, interaction.user.id, interaction.user.tag, subject, [description, info].filter(Boolean).join("\n"), evidence, "Recebido", created, created);
        const protocol = protocolFor(Number(result.lastInsertRowid));
        db.prepare("UPDATE cases SET protocol = ? WHERE id = ?").run(protocol, result.lastInsertRowid);
        const c = db.prepare("SELECT * FROM cases WHERE id = ?").get(result.lastInsertRowid);
        logEvent(c.id, interaction.user.id, "CRIADO", `Processo ${kind} registrado.`);
        const channel = await interaction.guild.channels.fetch(process.env.INTERNAL_CHANNEL_ID).catch(() => null);
        if (!channel?.isTextBased()) {
          await interaction.reply({ content: `Seu protocolo é **${protocol}**, mas houve um problema ao publicar no canal interno. Avise a equipe.`, ephemeral: true });
          return;
        }
        await channel.send({ content: `📥 Novo processo recebido — equipe autorizada: <@&${process.env.CORREGEDOR_ROLE_ID}> <@&${process.env.ALTO_COMANDO_ROLE_ID}>`, embeds: [caseEmbed(c, "Novo processo recebido")], components: [staffButtons(protocol)] });
        await interaction.reply({ content: `✅ Sua solicitação foi registrada.\n\n**Protocolo:** \`${protocol}\`\n**Natureza:** ${kind}\n**Status:** Recebido\n\nGuarde seu protocolo. Use **Acompanhar processo** na central para consultar as atualizações.`, ephemeral: true });
        await sendAudit(interaction.guild, `SICOR | Novo processo ${protocol} (${kind}) criado por <@${interaction.user.id}>.`);
        return;
      }

      if (id === "sicor:lookup") {
        const protocol = interaction.fields.getTextInputValue("protocol").toUpperCase().trim();
        const c = db.prepare("SELECT * FROM cases WHERE protocol = ?").get(protocol);
        if (!c) return interaction.reply({ content: "Não encontrei esse protocolo.", ephemeral: true });
        if (c.requester_id !== interaction.user.id && !isStaff(interaction.member)) return interaction.reply({ content: "Você não tem autorização para consultar esse processo.", ephemeral: true });
        return interaction.reply({ embeds: [caseEmbed(c, "Acompanhamento de processo")], ephemeral: true });
      }

      if (id === "sicor:addevidence") {
        const protocol = interaction.fields.getTextInputValue("protocol").toUpperCase().trim();
        const evidence = interaction.fields.getTextInputValue("evidence");
        const c = db.prepare("SELECT * FROM cases WHERE protocol = ?").get(protocol);
        if (!c) return interaction.reply({ content: "Não encontrei esse protocolo.", ephemeral: true });
        if (c.requester_id !== interaction.user.id && !isStaff(interaction.member)) return interaction.reply({ content: "Você não tem autorização para complementar esse processo.", ephemeral: true });
        db.prepare("UPDATE cases SET evidence = ?, updated_at = ? WHERE id = ?").run([c.evidence, `Complemento enviado em ${now()}: ${evidence}`].filter(Boolean).join("\n\n"), now(), c.id);
        logEvent(c.id, interaction.user.id, "EVIDENCIA", "Evidência complementar enviada.");
        const channel = await interaction.guild.channels.fetch(process.env.INTERNAL_CHANNEL_ID).catch(() => null);
        if (channel?.isTextBased()) await channel.send(`📎 Nova evidência complementar em **${protocol}** enviada por <@${interaction.user.id}>:\n${escapeText(evidence, 1500)}`);
        return interaction.reply({ content: `Evidências complementares registradas no processo **${protocol}**.`, ephemeral: true });
      }

      if (id.startsWith("sicor:staffform:")) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: "Acesso restrito.", ephemeral: true });
        const [, , action, ...parts] = id.split(":");
        const protocol = parts.join(":");
        const text = interaction.fields.getTextInputValue("text");
        const c = db.prepare("SELECT * FROM cases WHERE protocol = ?").get(protocol);
        if (!c) return interaction.reply({ content: "Processo não encontrado.", ephemeral: true });
        if (action === "decision" && !isHighCommand(interaction.member)) return interaction.reply({ content: "Somente o Alto-Comando pode registrar a decisão final nesta versão inicial.", ephemeral: true });
        if (action === "decision") {
          db.prepare("UPDATE cases SET decision = ?, status = ?, updated_at = ? WHERE id = ?").run(text, "Decidido", now(), c.id);
          logEvent(c.id, interaction.user.id, "DECISAO", text);
        } else {
          logEvent(c.id, interaction.user.id, action === "requestevidence" ? "SOLICITACAO_EVIDENCIA" : "MENSAGEM", text);
          if (action === "requestevidence") {
            db.prepare("UPDATE cases SET status = ?, updated_at = ? WHERE id = ?").run("Aguardando evidências", now(), c.id);
          } else {
            db.prepare("UPDATE cases SET updated_at = ? WHERE id = ?").run(now(), c.id);
          }
        }
        const sent = await notifyRequester(c.requester_id, `⚖️ **SICOR — Mensagem sobre ${protocol}**\n\n${action === "requestevidence" ? "**A corregedoria solicitou evidências complementares:**\n" : action === "decision" ? "**Decisão registrada:**\n" : ""}${text}\n\nVocê pode consultar seu processo pela Central SICOR.`);
        const updated = db.prepare("SELECT * FROM cases WHERE id = ?").get(c.id);
        const channel = await interaction.guild.channels.fetch(process.env.INTERNAL_CHANNEL_ID).catch(() => null);
        if (channel?.isTextBased()) await channel.send({ embeds: [caseEmbed(updated, action === "decision" ? "Decisão registrada" : "Movimentação do processo")] });
        await sendAudit(interaction.guild, `SICOR | ${protocol}: ${action} por <@${interaction.user.id}>. DM enviada: ${sent ? "sim" : "não"}.`);
        return interaction.reply({ content: `Ação registrada para ${protocol}. Mensagem privada enviada: ${sent ? "sim" : "não"}.`, ephemeral: true });
      }
    }
  } catch (error) {
    console.error("Erro ao processar interação:", error);
    const reply = { content: "Ocorreu um erro ao processar essa ação. A equipe deve verificar os logs do bot.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

(async () => {
  try {
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error("Não foi possível iniciar o SICOR:", err);
    process.exit(1);
  }
})();
