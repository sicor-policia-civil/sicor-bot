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
  PermissionFlagsBits,
} = require("discord.js");

const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

// ==================================================
// SICOR — SISTEMA INTEGRADO DE CORREGEDORIA
// Polícia Civil | Sistema de atendimento e processos
// ==================================================

const REQUIRED_ENV = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "INTERNAL_CHANNEL_ID",
  "CORREGEDOR_ROLE_ID",
  "ALTO_COMANDO_ROLE_ID",
];

const missingEnv = REQUIRED_ENV.filter(
  (key) => !process.env[key]
);

if (missingEnv.length > 0) {
  console.error(
    `[SICOR] Variáveis ausentes: ${missingEnv.join(", ")}`
  );
  process.exit(1);
}

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  INTERNAL_CHANNEL_ID,
  CORREGEDOR_ROLE_ID,
  ALTO_COMANDO_ROLE_ID,
} = process.env;

// Banco de dados na pasta do próprio projeto
const dataDir = path.join(__dirname, "data");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(
  path.join(dataDir, "sicor.sqlite")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ==================================================
// BANCO DE DADOS
// ==================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    requester_id TEXT NOT NULL,
    requester_tag TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    unit TEXT DEFAULT '',
    occurred_at TEXT DEFAULT '',
    evidence TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Recebido',
    decision TEXT DEFAULT '',
    assigned_to TEXT DEFAULT '',
    internal_message_id TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_tag TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (protocol)
      REFERENCES cases(protocol)
      ON DELETE CASCADE
  );
`);

const insertEvent = db.prepare(`
  INSERT INTO events (
    protocol,
    actor_id,
    actor_tag,
    action,
    details,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?)
`);

const getCase = db.prepare(`
  SELECT * FROM cases
  WHERE protocol = ?
`);

const getUserCases = db.prepare(`
  SELECT * FROM cases
  WHERE requester_id = ?
  ORDER BY id DESC
  LIMIT 10
`);

const getRecentCases = db.prepare(`
  SELECT * FROM cases
  ORDER BY id DESC
  LIMIT 10
`);

const getEvents = db.prepare(`
  SELECT * FROM events
  WHERE protocol = ?
  ORDER BY id DESC
  LIMIT 20
`);

const updateStatus = db.prepare(`
  UPDATE cases
  SET status = ?, updated_at = ?
  WHERE protocol = ?
`);

const updateDecision = db.prepare(`
  UPDATE cases
  SET decision = ?, updated_at = ?
  WHERE protocol = ?
`);

const updateAssignee = db.prepare(`
  UPDATE cases
  SET assigned_to = ?, updated_at = ?
  WHERE protocol = ?
`);

const updateEvidence = db.prepare(`
  UPDATE cases
  SET evidence = ?, updated_at = ?
  WHERE protocol = ?
`);

// ==================================================
// CLIENTE DISCORD
// ==================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

const STATUS_OPTIONS = [
  {
    label: "Recebido",
    value: "Recebido",
    description: "Solicitação recebida",
  },
  {
    label: "Em análise",
    value: "Em análise",
    description: "Processo em análise",
  },
  {
    label: "Aguardando informações",
    value: "Aguardando informações",
    description: "Aguardando informações adicionais",
  },
  {
    label: "Concluído",
    value: "Concluído",
    description: "Processo concluído",
  },
  {
    label: "Arquivado",
    value: "Arquivado",
    description: "Processo arquivado",
  },
];

// ==================================================
// FUNÇÕES AUXILIARES
// ==================================================

function nowIso() {
  return new Date().toISOString();
}

function dateLabel(value) {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return "Data indisponível";
  }

  return `<t:${Math.floor(timestamp / 1000)}:F>`;
}

function safeText(value, fallback = "Não informado") {
  const text = String(value ?? "").trim();

  return text ? text.slice(0, 1024) : fallback;
}

function hasStaffRole(member) {
  if (!member?.roles?.cache) {
    return false;
  }

  return (
    member.roles.cache.has(CORREGEDOR_ROLE_ID) ||
    member.roles.cache.has(ALTO_COMANDO_ROLE_ID)
  );
}

function canAccessCase(interaction, record) {
  if (!record) {
    return false;
  }

  return (
    record.requester_id === interaction.user.id ||
    hasStaffRole(interaction.member)
  );
}

function addEvent(protocol, user, action, details = "") {
  insertEvent.run(
    protocol,
    user.id,
    user.tag ?? user.username,
    action,
    String(details).slice(0, 1000),
    nowIso()
  );
}

function caseEmbed(record) {
  return new EmbedBuilder()
    .setColor(
      record.status === "Concluído"
        ? 0x2ecc71
        : record.status === "Arquivado"
          ? 0x7f8c8d
          : 0xc9a227
    )
    .setTitle(`⚖️ SICOR | ${record.protocol}`)
    .setDescription(
      `**Tipo:** ${safeText(record.type)}\n` +
      `**Assunto:** ${safeText(record.subject)}\n` +
      `**Descrição:** ${safeText(record.description)}`
    )
    .addFields(
      {
        name: "Solicitante",
        value: `<@${record.requester_id}>`,
        inline: true,
      },
      {
        name: "Status",
        value: safeText(record.status),
        inline: true,
      },
      {
        name: "Unidade/Corporação",
        value: safeText(record.unit),
        inline: true,
      },
      {
        name: "Data do ocorrido",
        value: safeText(record.occurred_at),
        inline: true,
      },
      {
        name: "Responsável",
        value: record.assigned_to
          ? `<@${record.assigned_to}>`
          : "Não atribuído",
        inline: true,
      },
      {
        name: "Despacho/Decisão",
        value: safeText(record.decision),
        inline: false,
      },
      {
        name: "Evidências",
        value: safeText(record.evidence),
        inline: false,
      },
      {
        name: "Criado em",
        value: dateLabel(record.created_at),
        inline: true,
      },
      {
        name: "Última atualização",
        value: dateLabel(record.updated_at),
        inline: true,
      }
    )
    .setFooter({
      text: "SICOR • Sistema Integrado de Corregedoria",
    });
}

function staffButtons(protocol) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sicor:staff:status:${protocol}`)
      .setLabel("Alterar status")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`sicor:staff:decision:${protocol}`)
      .setLabel("Registrar despacho")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`sicor:staff:assign:${protocol}`)
      .setLabel("Assumir processo")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`sicor:staff:evidence:${protocol}`)
      .setLabel("Adicionar evidência")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`sicor:staff:history:${protocol}`)
      .setLabel("Histórico")
      .setStyle(ButtonStyle.Secondary)
  );
}

// ==================================================
// PAINEL PÚBLICO
// ==================================================

function publicPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0xc9a227)
    .setTitle("⚖️ SICOR — Corregedoria da Polícia Civil")
    .setDescription(
      "Bem-vindo à Central de Atendimento da Corregedoria.\n\n" +
      "Utilize os botões abaixo para registrar uma solicitação " +
      "ou acompanhar um processo administrativo.\n\n" +
      "📋 **Registrar denúncia:** comunique irregularidades.\n" +
      "⚖️ **Recorrer de punição:** solicite a revisão de uma punição.\n" +
      "❓ **Retirar dúvidas:** encaminhe dúvidas à Corregedoria.\n" +
      "📎 **Enviar evidências:** registre informações e evidências.\n" +
      "🔎 **Acompanhar processo:** consulte seu protocolo.\n\n" +
      "🔒 As solicitações serão encaminhadas à equipe autorizada."
    )
    .setFooter({
      text: "SICOR • Sistema Integrado de Corregedoria",
    });
}

function publicPanelRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("sicor:new:Denúncia")
      .setLabel("Registrar denúncia")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("sicor:new:Recurso de punição")
      .setLabel("Recorrer de punição")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("sicor:new:Dúvida")
      .setLabel("Retirar dúvidas")
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("sicor:new:Envio de evidências")
      .setLabel("Enviar evidências")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("sicor:track")
      .setLabel("Acompanhar processo")
      .setStyle(ButtonStyle.Success)
  );

  return [row1, row2];
}

// ==================================================
// FORMULÁRIOS
// ==================================================

function buildRequestModal(type) {
  const modal = new ModalBuilder()
    .setCustomId(`sicor:submit:${type}`)
    .setTitle(`SICOR | ${type}`.slice(0, 45));

  const subject = new TextInputBuilder()
    .setCustomId("subject")
    .setLabel("Assunto")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Resuma o motivo da solicitação")
    .setMaxLength(100)
    .setRequired(true);

  const description = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("Descrição detalhada")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Relate os fatos de forma clara e objetiva")
    .setMaxLength(1000)
    .setRequired(true);

  const unit = new TextInputBuilder()
    .setCustomId("unit")
    .setLabel("Unidade/Corporação (opcional)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Nome ou identificação da unidade")
    .setMaxLength(100)
    .setRequired(false);

  const occurredAt = new TextInputBuilder()
    .setCustomId("occurred_at")
    .setLabel("Data/horário do ocorrido (opcional)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Ex.: 17/10/2026, por volta das 14h")
    .setMaxLength(100)
    .setRequired(false);

  const evidence = new TextInputBuilder()
    .setCustomId("evidence")
    .setLabel("Evidências/links (opcional)")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Cole links ou descreva as evidências")
    .setMaxLength(1000)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(subject),
    new ActionRowBuilder().addComponents(description),
    new ActionRowBuilder().addComponents(unit),
    new ActionRowBuilder().addComponents(occurredAt),
    new ActionRowBuilder().addComponents(evidence)
  );

  return modal;
}

function buildDecisionModal(protocol) {
  const input = new TextInputBuilder()
    .setCustomId("decision")
    .setLabel("Despacho/decisão")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(true)
    .setPlaceholder("Registre a decisão ou observação oficial.");

  return new ModalBuilder()
    .setCustomId(`sicor:modal:decision:${protocol}`)
    .setTitle("SICOR | Registrar despacho")
    .addComponents(
      new ActionRowBuilder().addComponents(input)
    );
}

function buildEvidenceModal(protocol) {
  const input = new TextInputBuilder()
    .setCustomId("evidence")
    .setLabel("Nova evidência")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(true)
    .setPlaceholder("Cole um link ou descreva a evidência.");

  return new ModalBuilder()
    .setCustomId(`sicor:modal:evidence:${protocol}`)
    .setTitle("SICOR | Adicionar evidência")
    .addComponents(
      new ActionRowBuilder().addComponents(input)
    );
}

function buildTrackModal() {
  const input = new TextInputBuilder()
    .setCustomId("protocol")
    .setLabel("Número do protocolo")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(30)
    .setRequired(true)
    .setPlaceholder("Ex.: SICOR-2026-0001");

  return new ModalBuilder()
    .setCustomId("sicor:modal:track")
    .setTitle("SICOR | Acompanhar processo")
    .addComponents(
      new ActionRowBuilder().addComponents(input)
    );
}

function buildStatusMenu(protocol) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`sicor:statuspick:${protocol}`)
      .setPlaceholder("Selecione o novo status")
      .addOptions(STATUS_OPTIONS)
  );
}

// ==================================================
// COMANDOS SLASH
// ==================================================

const commands = [
  new SlashCommandBuilder()
    .setName("sicor-ajuda")
    .setDescription("Exibe os comandos do SICOR."),

  new SlashCommandBuilder()
    .setName("sicor-publicar-painel")
    .setDescription("Publica o painel de atendimento do SICOR.")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),

  new SlashCommandBuilder()
    .setName("sicor-processo")
    .setDescription("Consulta um processo SICOR.")
    .addStringOption((option) =>
      option
        .setName("protocolo")
        .setDescription("Protocolo do processo")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("sicor-meus-processos")
    .setDescription("Lista seus processos registrados."),

  new SlashCommandBuilder()
    .setName("sicor-relatorio")
    .setDescription("Exibe o relatório interno do SICOR."),

  new SlashCommandBuilder()
    .setName("sicor-historico")
    .setDescription("Consulta o histórico de um processo.")
    .addStringOption((option) =>
      option
        .setName("protocolo")
        .setDescription("Protocolo do processo")
        .setRequired(true)
    ),
].map((command) => command.toJSON());

// ==================================================
// INICIALIZAÇÃO E CANAL INTERNO
// ==================================================

async function registerCommands() {
  const rest = new REST({ version: "10" })
    .setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("[SICOR] Comandos registrados.");
}

async function fetchInternalChannel(guild) {
  if (!guild) {
    throw new Error("A ação precisa ser executada no servidor.");
  }

  const channel = await guild.channels.fetch(
    INTERNAL_CHANNEL_ID
  );

  if (!channel || !channel.isTextBased() || !channel.send) {
    throw new Error(
      "Canal interno inválido. Confira INTERNAL_CHANNEL_ID."
    );
  }

  return channel;
}

async function sendCaseToStaff(guild, record) {
  const channel = await fetchInternalChannel(guild);

  const message = await channel.send({
    content:
      `<@&${CORREGEDOR_ROLE_ID}> ` +
      `<@&${ALTO_COMANDO_ROLE_ID}>\n` +
      `Novo processo recebido: **${record.protocol}**`,

    embeds: [caseEmbed(record)],
    components: [staffButtons(record.protocol)],

    allowedMentions: {
      roles: [
        CORREGEDOR_ROLE_ID,
        ALTO_COMANDO_ROLE_ID,
      ],
    },
  });

  db.prepare(`
    UPDATE cases
    SET internal_message_id = ?
    WHERE protocol = ?
  `).run(message.id, record.protocol);
}

async function refreshInternalCase(guild, record) {
  if (!record?.internal_message_id) {
    return;
  }

  const channel = await fetchInternalChannel(guild);

  const message = await channel.messages
    .fetch(record.internal_message_id)
    .catch(() => null);

  if (message) {
    await message.edit({
      embeds: [caseEmbed(record)],
      components: [staffButtons(record.protocol)],
      allowedMentions: { parse: [] },
    });
  }
}

async function showHistory(interaction, protocol) {
  const record = getCase.get(protocol);

  if (!record) {
    return interaction.reply({
      content: "❌ Processo não encontrado.",
      ephemeral: true,
    });
  }

  if (!canAccessCase(interaction, record)) {
    return interaction.reply({
      content: "⛔ Você não tem autorização para consultar esse histórico.",
      ephemeral: true,
    });
  }

  const events = getEvents.all(protocol);

  const description = events.length
    ? events.map((event) =>
        `**${event.action}** — ${dateLabel(event.created_at)}\n` +
        `Responsável: ${event.actor_tag}\n` +
        (event.details ? `Detalhes: ${event.details}` : "")
      ).join("\n\n").slice(0, 4000)
    : "Nenhuma movimentação registrada.";

  const embed = new EmbedBuilder()
    .setColor(0xc9a227)
    .setTitle(`📜 Histórico | ${protocol}`)
    .setDescription(description)
    .setFooter({
      text: "SICOR • Histórico de movimentações",
    });

  return interaction.reply({
    embeds: [embed],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

// ==================================================
// EVENTO READY
// ==================================================

client.once("ready", () => {
  console.log(
    `[SICOR] Bot conectado como ${client.user.tag}`
  );
});

// ==================================================
// TRATAMENTO DE INTERAÇÕES
// ==================================================

client.on("interactionCreate", async (interaction) => {
  try {

    // ----------------------------------------------
    // COMANDOS SLASH
    // ----------------------------------------------

    if (interaction.isChatInputCommand()) {

      if (interaction.commandName === "sicor-ajuda") {
        const embed = new EmbedBuilder()
          .setColor(0xc9a227)
          .setTitle("⚖️ SICOR — Central de Ajuda")
          .setDescription(
            "`/sicor-ajuda` — exibe esta ajuda.\n\n" +
            "`/sicor-publicar-painel` — publica o painel.\n\n" +
            "`/sicor-processo` — consulta um processo.\n\n" +
            "`/sicor-meus-processos` — lista seus processos.\n\n" +
            "`/sicor-historico` — consulta movimentações.\n\n" +
            "`/sicor-relatorio` — relatório interno da equipe."
          );

        return interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });
      }

      if (
        interaction.commandName ===
        "sicor-publicar-painel"
      ) {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({
            content:
              "⛔ Apenas Corregedores ou Alto-Comando podem publicar o painel.",
            ephemeral: true,
          });
        }

        return interaction.reply({
          embeds: [publicPanelEmbed()],
          components: publicPanelRows(),
          allowedMentions: { parse: [] },
        });
      }

      if (interaction.commandName === "sicor-processo") {
        const protocol = interaction.options
          .getString("protocolo", true)
          .trim()
          .toUpperCase();

        const record = getCase.get(protocol);

        if (!record) {
          return interaction.reply({
            content: "❌ Processo não encontrado.",
            ephemeral: true,
          });
        }

        if (!canAccessCase(interaction, record)) {
          return interaction.reply({
            content:
              "⛔ Você não tem autorização para consultar esse processo.",
            ephemeral: true,
          });
        }

        return interaction.reply({
          embeds: [caseEmbed(record)],
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
      }

      if (
        interaction.commandName ===
        "sicor-meus-processos"
      ) {
        const records = getUserCases.all(
          interaction.user.id
        );

        if (!records.length) {
          return interaction.reply({
            content:
              "Você ainda não possui processos registrados no SICOR.",
            ephemeral: true,
          });
        }

        const embed = new EmbedBuilder()
          .setColor(0xc9a227)
          .setTitle("📂 Meus processos")
          .setDescription(
            records.map((record) =>
              `**${record.protocol}** — ${record.type}\n` +
              `Status: **${record.status}**\n` +
              `Assunto: ${record.subject}`
            ).join("\n\n").slice(0, 4000)
          );

        return interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });
      }

      if (interaction.commandName === "sicor-relatorio") {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({
            content:
              "⛔ Apenas Corregedores ou Alto-Comando podem consultar o relatório.",
            ephemeral: true,
          });
        }

        const total = db.prepare(`
          SELECT COUNT(*) AS total FROM cases
        `).get().total;

        const counts = db.prepare(`
          SELECT status, COUNT(*) AS total
          FROM cases
          GROUP BY status
        `).all();

        const records = getRecentCases.all();

        const embed = new EmbedBuilder()
          .setColor(0xc9a227)
          .setTitle("📊 Relatório SICOR")
          .setDescription(
            `**Total de processos:** ${total}\n\n` +
            (
              counts.map((item) =>
                `**${item.status}:** ${item.total}`
              ).join("\n") ||
              "Nenhum processo registrado."
            )
          )
          .addFields({
            name: "Processos recentes",
            value: records.length
              ? records.map((record) =>
                  `**${record.protocol}** — ${record.status} — ${record.subject}`
                ).join("\n").slice(0, 1024)
              : "Nenhum processo registrado.",
          });

        return interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });
      }

      if (interaction.commandName === "sicor-historico") {
        const protocol = interaction.options
          .getString("protocolo", true)
          .trim()
          .toUpperCase();

        return showHistory(interaction, protocol);
      }
    }

    // ----------------------------------------------
    // BOTÕES
    // ----------------------------------------------

    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith("sicor:new:")) {
        const type = id.slice("sicor:new:".length);

        return interaction.showModal(
          buildRequestModal(type)
        );
      }

      if (id === "sicor:track") {
        return interaction.showModal(
          buildTrackModal()
        );
      }

      if (id.startsWith("sicor:staff:")) {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({
            content:
              "⛔ Acesso restrito à equipe da Corregedoria.",
            ephemeral: true,
          });
        }

        const [, , action, protocol] = id.split(":");
        const record = getCase.get(protocol);

        if (!record) {
          return interaction.reply({
            content: "❌ Processo não encontrado.",
            ephemeral: true,
          });
        }

        if (action === "status") {
          return interaction.reply({
            content:
              `Selecione o novo status do processo **${protocol}**:`,
            components: [buildStatusMenu(protocol)],
            ephemeral: true,
          });
        }

        if (action === "decision") {
          return interaction.showModal(
            buildDecisionModal(protocol)
          );
        }

        if (action === "evidence") {
          return interaction.showModal(
            buildEvidenceModal(protocol)
          );
        }

        if (action === "assign") {
          updateAssignee.run(
            interaction.user.id,
            nowIso(),
            protocol
          );

          addEvent(
            protocol,
            interaction.user,
            "Processo assumido",
            `Responsável: ${interaction.user.tag}`
          );

          const updated = getCase.get(protocol);

          await interaction.reply({
            content:
              `✅ Você assumiu o processo **${protocol}**.`,
            ephemeral: true,
          });

          await refreshInternalCase(
            interaction.guild,
            updated
          );

          return;
        }

        if (action === "history") {
          return showHistory(interaction, protocol);
        }
      }
    }

    // ----------------------------------------------
    // MENU DE STATUS
    // ----------------------------------------------

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("sicor:statuspick:")
    ) {
      if (!hasStaffRole(interaction.member)) {
        return interaction.reply({
          content:
            "⛔ Acesso restrito à equipe da Corregedoria.",
          ephemeral: true,
        });
      }

      const protocol = interaction.customId.slice(
        "sicor:statuspick:".length
      );

      const status = interaction.values[0];

      if (
        !STATUS_OPTIONS.some(
          (option) => option.value === status
        )
      ) {
        return interaction.reply({
          content: "Status inválido.",
          ephemeral: true,
        });
      }

      const record = getCase.get(protocol);

      if (!record) {
        return interaction.update({
          content: "❌ Processo não encontrado.",
          components: [],
        });
      }

      updateStatus.run(status, nowIso(), protocol);

      addEvent(
        protocol,
        interaction.user,
        "Status alterado",
        `Novo status: ${status}`
      );

      const updated = getCase.get(protocol);

      await interaction.update({
        content:
          `✅ Status de **${protocol}** alterado para **${status}**.`,
        components: [],
      });

      await refreshInternalCase(
        interaction.guild,
        updated
      );

      return;
    }

    // ----------------------------------------------
    // FORMULÁRIOS ENVIADOS
    // ----------------------------------------------

    if (interaction.isModalSubmit()) {

      // NOVA SOLICITAÇÃO
      if (
        interaction.customId.startsWith(
          "sicor:submit:"
        )
      ) {
        const type = interaction.customId.slice(
          "sicor:submit:".length
        );

        const subject = interaction.fields
          .getTextInputValue("subject")
          .trim();

        const description = interaction.fields
          .getTextInputValue("description")
          .trim();

        // Campos opcionais tratados sem causar erro
        const unit = interaction.fields.fields.has("unit")
          ? interaction.fields.getTextInputValue("unit").trim()
          : "";

        const occurredAt = interaction.fields.fields.has("occurred_at")
          ? interaction.fields.getTextInputValue("occurred_at").trim()
          : "";

        const evidence = interaction.fields.fields.has("evidence")
          ? interaction.fields.getTextInputValue("evidence").trim()
          : "";

        const timestamp = nowIso();

        // Primeiro insere com protocolo temporário
        const result = db.prepare(`
          INSERT INTO cases (
            protocol,
            type,
            requester_id,
            requester_tag,
            subject,
            description,
            unit,
            occurred_at,
            evidence,
            status,
            created_at,
            updated_at
          )
          VALUES (
            'PENDING',
            ?, ?, ?, ?, ?, ?, ?, ?,
            'Recebido',
            ?, ?
          )
        `).run(
          type,
          interaction.user.id,
          interaction.user.tag ?? interaction.user.username,
          subject,
          description,
          unit,
          occurredAt,
          evidence,
          timestamp,
          timestamp
        );

        const protocol =
          `SICOR-${new Date().getFullYear()}-` +
          String(result.lastInsertRowid).padStart(4, "0");

        db.prepare(`
          UPDATE cases
          SET protocol = ?
          WHERE id = ?
        `).run(protocol, result.lastInsertRowid);

        addEvent(
          protocol,
          interaction.user,
          "Processo criado",
          `Tipo: ${type}`
        );

        const record = getCase.get(protocol);

        await interaction.reply({
          content:
            "✅ Sua solicitação foi registrada!\n\n" +
            `**Protocolo:** \`${protocol}\`\n\n` +
            "Guarde esse número para acompanhar seu processo.",
          ephemeral: true,
        });

        try {
          await sendCaseToStaff(
            interaction.guild,
            record
          );
        } catch (error) {
          console.error(
            "[SICOR] Erro ao notificar a equipe:",
            error
          );

          await interaction.followUp({
            content:
              "⚠️ Seu protocolo foi salvo, mas não consegui notificar a equipe. Avise um administrador.",
            ephemeral: true,
          }).catch(() => {});
        }

        return;
      }

      // ACOMPANHAR PROCESSO
      if (
        interaction.customId === "sicor:modal:track"
      ) {
        const protocol = interaction.fields
          .getTextInputValue("protocol")
          .trim()
          .toUpperCase();

        const record = getCase.get(protocol);

        if (!record) {
          return interaction.reply({
            content:
              "❌ Protocolo não encontrado. Confira o número e tente novamente.",
            ephemeral: true,
          });
        }

        if (!canAccessCase(interaction, record)) {
          return interaction.reply({
            content:
              "⛔ Somente o solicitante e a equipe autorizada podem consultar esse processo.",
            ephemeral: true,
          });
        }

        return interaction.reply({
          embeds: [caseEmbed(record)],
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
      }

      // REGISTRAR DESPACHO
      if (
        interaction.customId.startsWith(
          "sicor:modal:decision:"
        )
      ) {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({
            content: "⛔ Acesso restrito à equipe.",
            ephemeral: true,
          });
        }

        const protocol = interaction.customId.slice(
          "sicor:modal:decision:".length
        );

        const decision = interaction.fields
          .getTextInputValue("decision")
          .trim();

        const record = getCase.get(protocol);

        if (!record) {
          return interaction.reply({
            content: "❌ Processo não encontrado.",
            ephemeral: true,
          });
        }

        updateDecision.run(
          decision,
          nowIso(),
          protocol
        );

        addEvent(
          protocol,
          interaction.user,
          "Despacho registrado",
          decision
        );

        await interaction.reply({
          content:
            `✅ Despacho registrado no processo **${protocol}**.`,
          ephemeral: true,
        });

        await refreshInternalCase(
          interaction.guild,
          getCase.get(protocol)
        );

        return;
      }

      // ADICIONAR EVIDÊNCIA
      if (
        interaction.customId.startsWith(
          "sicor:modal:evidence:"
        )
      ) {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({
            content: "⛔ Acesso restrito à equipe.",
            ephemeral: true,
          });
        }

        const protocol = interaction.customId.slice(
          "sicor:modal:evidence:".length
        );

        const newEvidence = interaction.fields
          .getTextInputValue("evidence")
          .trim();

        const record = getCase.get(protocol);

        if (!record) {
          return interaction.reply({
            content: "❌ Processo não encontrado.",
            ephemeral: true,
          });
        }

        const combined = [
          record.evidence,
          newEvidence,
        ].filter(Boolean).join("\n\n");

        updateEvidence.run(
          combined.slice(0, 1000),
          nowIso(),
          protocol
        );

        addEvent(
          protocol,
          interaction.user,
          "Evidência adicionada",
          newEvidence
        );

        await interaction.reply({
          content:
            `✅ Evidência adicionada ao processo **${protocol}**.`,
          ephemeral: true,
        });

        await refreshInternalCase(
          interaction.guild,
          getCase.get(protocol)
        );

        return;
      }
    }

  } catch (error) {
    console.error(
      "[SICOR] Erro ao processar interação:",
      error
    );

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content:
          "❌ Ocorreu um erro ao processar essa ação. Confira as configurações do bot e tente novamente.",
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

// ==================================================
// INICIAR BOT
// ==================================================

(async () => {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error(
      "[SICOR] Falha ao iniciar o bot:",
      error
    );

    process.exit(1);
  }
})();
