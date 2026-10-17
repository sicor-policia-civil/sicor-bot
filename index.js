require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const {
  Client,
  GatewayIntentBits,
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

// ==================================================
// SICOR — SISTEMA INTEGRADO DE CORREGEDORIA
// POLÍCIA CIVIL | REDUTO ONLINE
// ==================================================

// CONFIGURAÇÕES DA APLICAÇÃO

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const CLIENT_ID = "1561124070907711528";
const GUILD_ID = "1540152016486011003";
const INTERNAL_CHANNEL_ID = "1548107581518516254";

const CORREGEDOR_ROLE_ID = "1547390225607692419";
const ALTO_COMANDO_ROLE_ID = "1540171391704498196";

// VERIFICAÇÃO DO TOKEN

if (!DISCORD_TOKEN) {
  console.error(
    "[SICOR] ERRO: configure a variável DISCORD_TOKEN na hospedagem."
  );
  process.exit(1);
}

// ==================================================
// CLIENTE DO DISCORD
// ==================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ==================================================
// BANCO DE DADOS
// ==================================================

const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, "sicor.sqlite"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol TEXT UNIQUE,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    involved TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence TEXT,
    author_id TEXT NOT NULL,
    author_tag TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Recebido',
    assigned_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    actor_tag TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(case_id) REFERENCES cases(id)
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("cases", "involved", "TEXT NOT NULL DEFAULT 'Não informado'");
ensureColumn("cases", "evidence", "TEXT");
ensureColumn("cases", "assigned_to", "TEXT");

// ==================================================
// CONSTANTES E FUNÇÕES AUXILIARES
// ==================================================

const COLORS = {
  black: 0x111111,
  white: 0xFFFFFF,
  gold: 0xC9A227,
  red: 0xB22222,
  green: 0x228B22,
  gray: 0x555555
};

const CASE_TYPES = {
  denuncia: "Denúncia",
  recurso: "Recurso de punição",
  duvida: "Dúvida",
  evidencia: "Envio de evidências",
  acompanhamento: "Acompanhamento de processo"
};

const STATUSES = [
  { label: "Recebido", value: "Recebido" },
  { label: "Em análise", value: "Em análise" },
  { label: "Em diligência", value: "Em diligência" },
  { label: "Concluído", value: "Concluído" },
  { label: "Arquivado", value: "Arquivado" },
  { label: "Indeferido", value: "Indeferido" }
];

function now() {
  return new Date().toISOString();
}

function formatDate(date) {
  if (!date) return "Não informado";

  return new Date(date).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo"
  });
}

function clip(value, max = 1000) {
  const text = String(value ?? "").trim();

  return text.length <= max
    ? text
    : text.slice(0, max - 3) + "...";
}

function getText(interaction, field) {
  try {
    return interaction.fields.getTextInputValue(field).trim();
  } catch {
    return "";
  }
}

function getMemberRoleIds(member) {
  if (!member) return [];

  if (member.roles?.cache) {
    return [...member.roles.cache.keys()];
  }

  if (Array.isArray(member.roles)) {
    return member.roles;
  }

  return [];
}

function hasStaffRole(member) {
  const roles = getMemberRoleIds(member);

  return (
    roles.includes(CORREGEDOR_ROLE_ID) ||
    roles.includes(ALTO_COMANDO_ROLE_ID)
  );
}

function staffOnly(interaction) {
  return hasStaffRole(interaction.member);
}

function makeEmbed(title, description, color = COLORS.gold) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({
      text: "SICOR • Polícia Civil • Reduto Online"
    })
    .setTimestamp();
}

function getCaseByProtocol(protocol) {
  return db.prepare(
    "SELECT * FROM cases WHERE protocol = ?"
  ).get(String(protocol).trim().toUpperCase());
}

function getCaseById(id) {
  return db.prepare(
    "SELECT * FROM cases WHERE id = ?"
  ).get(Number(id));
}

function createProtocol() {
  const year = new Date().getFullYear();

  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM cases
    WHERE protocol LIKE ?
  `).get(`SICOR-${year}-%`);

  let sequence = Number(row.total) + 1;

  while (true) {
    const protocol = `SICOR-${year}-${String(sequence).padStart(4, "0")}`;

    const exists = db.prepare(
      "SELECT id FROM cases WHERE protocol = ?"
    ).get(protocol);

    if (!exists) return protocol;

    sequence++;
  }
}

function logEvent(caseId, interaction, action, details = "") {
  db.prepare(`
    INSERT INTO events (
      case_id,
      actor_id,
      actor_tag,
      action,
      details,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    caseId,
    interaction.user.id,
    interaction.user.tag,
    action,
    clip(details, 1000),
    now()
  );
}

function updateCaseStatus(caseId, status, interaction) {
  const record = getCaseById(caseId);

  if (!record) return false;

  db.prepare(`
    UPDATE cases
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).run(status, now(), caseId);

  logEvent(
    caseId,
    interaction,
    "Alteração de status",
    `${record.status} → ${status}`
  );

  return true;
}

// ==================================================
// EMBED DO PROCESSO
// ==================================================

function caseEmbed(record) {
  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle("⚖️ SICOR | Processo da Corregedoria")
    .setDescription(
      `**Protocolo:** \`${record.protocol}\`\n` +
      `**Tipo:** ${record.type}\n` +
      `**Status:** ${record.status}`
    )
    .addFields(
      {
        name: "Assunto",
        value: clip(record.subject, 1024) || "Não informado"
      },
      {
        name: "Envolvido(s)",
        value: clip(record.involved, 1024) || "Não informado"
      },
      {
        name: "Relato",
        value: clip(record.description, 1024) || "Não informado"
      },
      {
        name: "Evidências",
        value: clip(record.evidence || "Nenhuma evidência informada.", 1024)
      },
      {
        name: "Requerente",
        value: `<@${record.author_id}>`,
        inline: true
      },
      {
        name: "Responsável",
        value: record.assigned_to
          ? `<@${record.assigned_to}>`
          : "Não designado",
        inline: true
      },
      {
        name: "Abertura",
        value: formatDate(record.created_at),
        inline: true
      }
    )
    .setFooter({
      text: "SICOR • Polícia Civil • Reduto Online"
    })
    .setTimestamp(new Date(record.updated_at));
}

// ==================================================
// CONTROLES INTERNOS
// ==================================================

function staffComponents(caseId) {
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sicor:assumir:${caseId}`)
      .setLabel("Assumir processo")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`sicor:despacho:${caseId}`)
      .setLabel("Registrar despacho")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`sicor:evidencias:${caseId}`)
      .setLabel("Adicionar evidências")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`sicor:historico:${caseId}`)
      .setLabel("Histórico")
      .setStyle(ButtonStyle.Success)
  );

  const statusRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`sicor:status:${caseId}`)
      .setPlaceholder("Alterar status do processo")
      .addOptions(
        STATUSES.map((status) => ({
          label: status.label,
          value: status.value
        }))
      )
  );

  return [actionRow, statusRow];
}

// ==================================================
// PAINEL OFICIAL DA POLÍCIA CIVIL DO REDUTO
// ==================================================

function publicPanelEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.black)
    .setTitle("⚖️ SICOR — Sistema Integrado de Corregedoria")
    .setDescription(
      "**POLÍCIA CIVIL | REDUTO ONLINE**\n\n" +
      "Bem-vindo ao canal oficial de atendimento da Corregedoria da Polícia Civil do Reduto.\n\n" +
      "Utilize os botões abaixo para registrar sua solicitação.\n\n" +
      "📁 **Registrar denúncia:** comunicar possíveis irregularidades.\n" +
      "⚖️ **Recorrer de punição:** solicitar reavaliação de uma medida.\n" +
      "❔ **Retirar dúvidas:** encaminhar questionamentos à Corregedoria.\n" +
      "📎 **Enviar evidências:** apresentar informações relevantes.\n" +
      "🔎 **Acompanhar processo:** consultar um processo registrado.\n\n" +
      "🔒 As informações serão tratadas de forma restrita pela equipe autorizada."
    )
    .addFields({
      name: "Orientações",
      value:
        "Apresente informações verdadeiras, claras e objetivas. " +
        "O registro de uma solicitação não garante seu deferimento."
    })
    .setFooter({
      text: "SICOR • Polícia Civil • Reduto Online"
    })
    .setTimestamp();
}

function publicPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("sicor:new:denuncia")
        .setLabel("Registrar denúncia")
        .setEmoji("📁")
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId("sicor:new:recurso")
        .setLabel("Recorrer de punição")
        .setEmoji("⚖️")
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId("sicor:new:duvida")
        .setLabel("Retirar dúvidas")
        .setEmoji("❔")
        .setStyle(ButtonStyle.Secondary)
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("sicor:new:evidencia")
        .setLabel("Enviar evidências")
        .setEmoji("📎")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("sicor:new:acompanhamento")
        .setLabel("Acompanhar processo")
        .setEmoji("🔎")
        .setStyle(ButtonStyle.Success)
    )
  ];
}

// ==================================================
// FORMULÁRIOS
// ==================================================

function openCaseModal(interaction, typeKey) {
  const type = CASE_TYPES[typeKey];

  if (!type) {
    return interaction.reply({
      content: "Tipo de solicitação inválido.",
      ephemeral: true
    });
  }

  if (typeKey === "acompanhamento") {
    const modal = new ModalBuilder()
      .setCustomId("sicor:consultar")
      .setTitle("Acompanhar processo");

    const protocolInput = new TextInputBuilder()
      .setCustomId("protocol")
      .setLabel("Número do protocolo SICOR")
      .setPlaceholder("Ex.: SICOR-2026-0001")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(30);

    modal.addComponents(
      new ActionRowBuilder().addComponents(protocolInput)
    );

    return interaction.showModal(modal);
  }

  const modal = new ModalBuilder()
    .setCustomId(`sicor:form:${typeKey}`)
    .setTitle(type);

  const subjectInput = new TextInputBuilder()
    .setCustomId("subject")
    .setLabel("Assunto da solicitação")
    .setPlaceholder("Informe o assunto principal.")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const involvedInput = new TextInputBuilder()
    .setCustomId("involved")
    .setLabel("Policial ou pessoa envolvida")
    .setPlaceholder("Informe o nome ou ID, se aplicável.")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100);

  const descriptionInput = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("Relato detalhado")
    .setPlaceholder("Descreva os fatos com clareza e objetividade.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1800);

  const evidenceInput = new TextInputBuilder()
    .setCustomId("evidence")
    .setLabel("Links de evidências (opcional)")
    .setPlaceholder("Cole links de imagens, vídeos ou documentos.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(subjectInput),
    new ActionRowBuilder().addComponents(involvedInput),
    new ActionRowBuilder().addComponents(descriptionInput),
    new ActionRowBuilder().addComponents(evidenceInput)
  );

  return interaction.showModal(modal);
}

function openDispatchModal(interaction, caseId) {
  const modal = new ModalBuilder()
    .setCustomId(`sicor:despacho-form:${caseId}`)
    .setTitle("Registrar despacho");

  const dispatchInput = new TextInputBuilder()
    .setCustomId("dispatch")
    .setLabel("Despacho ou observação oficial")
    .setPlaceholder("Registre a decisão ou providência adotada.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1800);

  modal.addComponents(
    new ActionRowBuilder().addComponents(dispatchInput)
  );

  return interaction.showModal(modal);
}

function openEvidenceModal(interaction, caseId) {
  const modal = new ModalBuilder()
    .setCustomId(`sicor:evidencias-form:${caseId}`)
    .setTitle("Adicionar evidências");

  const evidenceInput = new TextInputBuilder()
    .setCustomId("evidence")
    .setLabel("Links e informações das evidências")
    .setPlaceholder("Cole os links e descreva o material apresentado.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1800);

  modal.addComponents(
    new ActionRowBuilder().addComponents(evidenceInput)
  );

  return interaction.showModal(modal);
}

// ==================================================
// COMANDOS SLASH
// ==================================================

const commands = [
  new SlashCommandBuilder()
    .setName("sicor-ajuda")
    .setDescription("Exibe as informações de utilização do SICOR."),

  new SlashCommandBuilder()
    .setName("sicor-publicar-painel")
    .setDescription("Publica o painel de atendimento da Corregedoria.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("sicor-processo")
    .setDescription("Consulta um processo pelo protocolo.")
    .addStringOption((option) =>
      option
        .setName("protocolo")
        .setDescription("Número do protocolo SICOR.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("sicor-meus-processos")
    .setDescription("Consulta os processos registrados por você."),

  new SlashCommandBuilder()
    .setName("sicor-relatorio")
    .setDescription("Exibe um relatório geral dos processos SICOR."),

  new SlashCommandBuilder()
    .setName("sicor-historico")
    .setDescription("Consulta o histórico de um processo.")
    .addStringOption((option) =>
      option
        .setName("protocolo")
        .setDescription("Número do protocolo SICOR.")
        .setRequired(true)
    )
].map((command) => command.toJSON());

// ==================================================
// REGISTRO DE COMANDOS
// ==================================================

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("[SICOR] Comandos registrados no servidor do Reduto.");
}

// ==================================================
// NOTIFICAÇÃO INTERNA
// ==================================================

async function notifyStaff(record) {
  const channel = await client.channels
    .fetch(INTERNAL_CHANNEL_ID)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) {
    console.error("[SICOR] Canal interno não encontrado.");
    return false;
  }

  await channel.send({
    content:
      "📥 **NOVO REGISTRO — CORREGEDORIA DA POLÍCIA CIVIL DO REDUTO**\n" +
      `Equipe responsável: <@&${CORREGEDOR_ROLE_ID}> <@&${ALTO_COMANDO_ROLE_ID}>`,
    embeds: [caseEmbed(record)],
    components: staffComponents(record.id),
    allowedMentions: {
      roles: [CORREGEDOR_ROLE_ID, ALTO_COMANDO_ROLE_ID]
    }
  });

  return true;
}

// ==================================================
// COMANDOS
// ==================================================

async function handleSlashCommand(interaction) {
  const command = interaction.commandName;

  if (command === "sicor-ajuda") {
    return interaction.reply({
      embeds: [
        makeEmbed(
          "⚖️ SICOR | Central de ajuda",
          "**POLÍCIA CIVIL | REDUTO ONLINE**\n\n" +
          "`/sicor-ajuda` — Exibe esta mensagem.\n" +
          "`/sicor-publicar-painel` — Publica o painel de atendimento.\n" +
          "`/sicor-processo` — Consulta um processo pelo protocolo.\n" +
          "`/sicor-meus-processos` — Consulta seus registros.\n" +
          "`/sicor-relatorio` — Exibe o relatório geral.\n" +
          "`/sicor-historico` — Consulta o histórico de um processo.\n\n" +
          "Utilize o painel oficial para registrar solicitações."
        )
      ],
      ephemeral: true
    });
  }

  if (command === "sicor-publicar-painel") {
    if (!staffOnly(interaction)) {
      return interaction.reply({
        content: "Você não possui autorização para publicar o painel.",
        ephemeral: true
      });
    }

    return interaction.reply({
      embeds: [publicPanelEmbed()],
      components: publicPanelButtons()
    });
  }

  if (command === "sicor-processo") {
    if (!staffOnly(interaction)) {
      return interaction.reply({
        content: "Você não possui autorização para consultar processos internos.",
        ephemeral: true
      });
    }

    const record = getCaseByProtocol(
      interaction.options.getString("protocolo")
    );

    if (!record) {
      return interaction.reply({
        content: "Nenhum processo foi encontrado com esse protocolo.",
        ephemeral: true
      });
    }

    return interaction.reply({
      embeds: [caseEmbed(record)],
      components: staffComponents(record.id),
      ephemeral: true
    });
  }

  if (command === "sicor-meus-processos") {
    const records = db.prepare(`
      SELECT protocol, type, subject, status, created_at
      FROM cases
      WHERE author_id = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(interaction.user.id);

    if (!records.length) {
      return interaction.reply({
        content: "Você ainda não possui processos registrados no SICOR.",
        ephemeral: true
      });
    }

    const description = records.map((record) =>
      `**${record.protocol}**\n` +
      `Tipo: ${record.type}\n` +
      `Assunto: ${clip(record.subject, 150)}\n` +
      `Status: **${record.status}**\n` +
      `Data: ${formatDate(record.created_at)}`
    ).join("\n\n");

    return interaction.reply({
      embeds: [
        makeEmbed("📂 SICOR | Meus processos", description, COLORS.white)
      ],
      ephemeral: true
    });
  }

  if (command === "sicor-relatorio") {
    if (!staffOnly(interaction)) {
      return interaction.reply({
        content: "Você não possui autorização para acessar relatórios internos.",
        ephemeral: true
      });
    }

    const statuses = db.prepare(`
      SELECT status, COUNT(*) AS total
      FROM cases
      GROUP BY status
    `).all();

    const total = statuses.reduce((sum, item) => sum + item.total, 0);

    const description = [
      `**Total de processos:** ${total}`,
      ...STATUSES.map((status) => {
        const found = statuses.find((item) => item.status === status.value);
        return `**${status.label}:** ${found ? found.total : 0}`;
      })
    ].join("\n");

    return interaction.reply({
      embeds: [
        makeEmbed("📊 SICOR | Relatório da Corregedoria", description)
      ],
      ephemeral: true
    });
  }

  if (command === "sicor-historico") {
    if (!staffOnly(interaction)) {
      return interaction.reply({
        content: "Você não possui autorização para consultar o histórico interno.",
        ephemeral: true
      });
    }

    const record = getCaseByProtocol(
      interaction.options.getString("protocolo")
    );

    if (!record) {
      return interaction.reply({
        content: "Nenhum processo foi encontrado com esse protocolo.",
        ephemeral: true
      });
    }

    const events = db.prepare(`
      SELECT *
      FROM events
      WHERE case_id = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(record.id);

    const description = events.length
      ? events.map((event) =>
          `**${event.action}**\n` +
          `Responsável: <@${event.actor_id}>\n` +
          `Data: ${formatDate(event.created_at)}\n` +
          `${clip(event.details || "Sem detalhes.", 500)}`
        ).join("\n\n")
      : "Nenhuma movimentação foi registrada neste processo.";

    return interaction.reply({
      embeds: [
        makeEmbed(`📜 Histórico | ${record.protocol}`, description)
      ],
      ephemeral: true
    });
  }
}

// ==================================================
// BOTÕES
// ==================================================

async function handleButton(interaction) {
  const id = interaction.customId;

  if (id.startsWith("sicor:new:")) {
    return openCaseModal(interaction, id.split(":")[2]);
  }

  if (!id.startsWith("sicor:")) return;

  const parts = id.split(":");
  const action = parts[1];
  const caseId = Number(parts[2]);

  if (!Number.isInteger(caseId) || caseId <= 0) {
    return interaction.reply({
      content: "Identificador de processo inválido.",
      ephemeral: true
    });
  }

  if (!staffOnly(interaction)) {
    return interaction.reply({
      content: "Acesso negado. Função exclusiva da equipe autorizada.",
      ephemeral: true
    });
  }

  const record = getCaseById(caseId);

  if (!record) {
    return interaction.reply({
      content: "Este processo não foi encontrado.",
      ephemeral: true
    });
  }

  if (action === "assumir") {
    if (record.assigned_to && record.assigned_to !== interaction.user.id) {
      return interaction.reply({
        content: `Este processo já está sob responsabilidade de <@${record.assigned_to}>.`,
        ephemeral: true
      });
    }

    db.prepare(`
      UPDATE cases
      SET assigned_to = ?, updated_at = ?
      WHERE id = ?
    `).run(interaction.user.id, now(), caseId);

    logEvent(
      caseId,
      interaction,
      "Processo assumido",
      `${interaction.user.tag} assumiu a responsabilidade.`
    );

    const updated = getCaseById(caseId);

    return interaction.update({
      embeds: [caseEmbed(updated)],
      components: staffComponents(caseId)
    });
  }

  if (action === "despacho") {
    return openDispatchModal(interaction, caseId);
  }

  if (action === "evidencias") {
    return openEvidenceModal(interaction, caseId);
  }

  if (action === "historico") {
    const events = db.prepare(`
      SELECT *
      FROM events
      WHERE case_id = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(caseId);

    const description = events.length
      ? events.map((event) =>
          `**${event.action}**\n` +
          `Responsável: <@${event.actor_id}>\n` +
          `Data: ${formatDate(event.created_at)}\n` +
          `${clip(event.details || "Sem detalhes.", 400)}`
        ).join("\n\n")
      : "Nenhuma movimentação registrada.";

    return interaction.reply({
      embeds: [
        makeEmbed(`📜 Histórico | ${record.protocol}`, description)
      ],
      ephemeral: true
    });
  }
}

// ==================================================
// MENUS DE STATUS
// ==================================================

async function handleSelectMenu(interaction) {
  if (!interaction.customId.startsWith("sicor:status:")) return;

  if (!staffOnly(interaction)) {
    return interaction.reply({
      content: "Você não possui autorização para alterar o status.",
      ephemeral: true
    });
  }

  const caseId = Number(interaction.customId.split(":")[2]);
  const status = interaction.values[0];

  if (!STATUSES.some((item) => item.value === status)) {
    return interaction.reply({
      content: "Status inválido.",
      ephemeral: true
    });
  }

  const record = getCaseById(caseId);

  if (!record) {
    return interaction.reply({
      content: "Processo não encontrado.",
      ephemeral: true
    });
  }

  updateCaseStatus(caseId, status, interaction);

  return interaction.update({
    embeds: [caseEmbed(getCaseById(caseId))],
    components: staffComponents(caseId)
  });
}

// ==================================================
// FORMULÁRIOS
// ==================================================

async function handleModal(interaction) {
  const id = interaction.customId;

  if (id === "sicor:consultar") {
    const protocol = getText(interaction, "protocol").toUpperCase();
    const record = getCaseByProtocol(protocol);

    if (!record) {
      return interaction.reply({
        content: "Nenhum processo foi encontrado com esse protocolo.",
        ephemeral: true
      });
    }

    const isOwner = record.author_id === interaction.user.id;

    if (!isOwner && !staffOnly(interaction)) {
      return interaction.reply({
        content: "Por segurança, somente o requerente ou a equipe autorizada pode consultar este processo.",
        ephemeral: true
      });
    }

    return interaction.reply({
      embeds: [
        makeEmbed(
          "🔎 SICOR | Consulta de processo",
          `**Protocolo:** ${record.protocol}\n` +
          `**Tipo:** ${record.type}\n` +
          `**Assunto:** ${clip(record.subject, 500)}\n` +
          `**Status:** ${record.status}\n` +
          `**Data de abertura:** ${formatDate(record.created_at)}`
        )
      ],
      ephemeral: true
    });
  }

  if (id.startsWith("sicor:form:")) {
    const typeKey = id.split(":")[2];
    const type = CASE_TYPES[typeKey];

    if (!type) {
      return interaction.reply({
        content: "Tipo de solicitação inválido.",
        ephemeral: true
      });
    }

    const subject = getText(interaction, "subject");
    const involved = getText(interaction, "involved") || "Não informado";
    const description = getText(interaction, "description");
    const evidence = getText(interaction, "evidence") || "";

    if (!subject || !description) {
      return interaction.reply({
        content: "Preencha o assunto e o relato detalhado.",
        ephemeral: true
      });
    }

    const createdAt = now();
    const protocol = createProtocol();

    const result = db.prepare(`
      INSERT INTO cases (
        protocol,
        type,
        subject,
        involved,
        description,
        evidence,
        author_id,
        author_tag,
        status,
        assigned_to,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      protocol,
      type,
      subject,
      involved,
      description,
      evidence,
      interaction.user.id,
      interaction.user.tag,
      "Recebido",
      null,
      createdAt,
      createdAt
    );

    const caseId = Number(result.lastInsertRowid);

    logEvent(
      caseId,
      interaction,
      "Processo registrado",
      `Tipo: ${type}. Protocolo: ${protocol}.`
    );

    let notificationSent = false;

    try {
      notificationSent = await notifyStaff(getCaseById(caseId));
    } catch (error) {
      console.error("[SICOR] Falha ao notificar a equipe:", error);
    }

    const embed = makeEmbed(
      "✅ Solicitação registrada",
      `Seu registro foi realizado com sucesso.\n\n` +
      `**Protocolo:** \`${protocol}\`\n` +
      `**Tipo:** ${type}\n` +
      `**Status:** Recebido\n\n` +
      "Guarde o número do protocolo para consultar o andamento.\n" +
      "A equipe responsável analisará as informações apresentadas.",
      COLORS.green
    );

    if (!notificationSent) {
      embed.addFields({
        name: "Aviso",
        value: "O registro foi salvo, mas a equipe não pôde ser notificada automaticamente. Informe o Alto-Comando."
      });
    }

    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }

  if (id.startsWith("sicor:despacho-form:")) {
    if (!staffOnly(interaction)) {
      return interaction.reply({
        content: "Acesso negado.",
        ephemeral: true
      });
    }

    const caseId = Number(id.split(":")[2]);
    const record = getCaseById(caseId);

    if (!record) {
      return interaction.reply({
        content: "Processo não encontrado.",
        ephemeral: true
      });
    }

    const dispatch = getText(interaction, "dispatch");

    if (!dispatch) {
      return interaction.reply({
        content: "O despacho não pode estar vazio.",
        ephemeral: true
      });
    }

    logEvent(caseId, interaction, "Despacho registrado", dispatch);

    db.prepare(`
      UPDATE cases
      SET updated_at = ?
      WHERE id = ?
    `).run(now(), caseId);

    return interaction.reply({
      embeds: [
        makeEmbed(
          "📑 Despacho registrado",
          `**Processo:** ${record.protocol}\n\n${clip(dispatch, 3000)}`,
          COLORS.green
        )
      ],
      ephemeral: true
    });
  }

  if (id.startsWith("sicor:evidencias-form:")) {
    if (!staffOnly(interaction)) {
      return interaction.reply({
        content: "Acesso negado.",
        ephemeral: true
      });
    }

    const caseId = Number(id.split(":")[2]);
    const record = getCaseById(caseId);

    if (!record) {
      return interaction.reply({
        content: "Processo não encontrado.",
        ephemeral: true
      });
    }

    const evidence = getText(interaction, "evidence");

    if (!evidence) {
      return interaction.reply({
        content: "Informe as evidências.",
        ephemeral: true
      });
    }

    const updatedEvidence = record.evidence
      ? `${record.evidence}\n\n[${formatDate(now())}] ${interaction.user.tag}:\n${evidence}`
      : `[${formatDate(now())}] ${interaction.user.tag}:\n${evidence}`;

    db.prepare(`
      UPDATE cases
      SET evidence = ?, updated_at = ?
      WHERE id = ?
    `).run(clip(updatedEvidence, 5000), now(), caseId);

    logEvent(caseId, interaction, "Evidências adicionadas", evidence);

    return interaction.reply({
      content: `Evidências adicionadas ao processo **${record.protocol}**.`,
      ephemeral: true
    });
  }
}

// ==================================================
// EVENTOS DO DISCORD
// ==================================================

client.once("ready", () => {
  console.log("====================================");
  console.log("[SICOR] Sistema iniciado.");
  console.log(`[SICOR] Bot conectado como ${client.user.tag}`);
  console.log("[SICOR] Organização: Polícia Civil do Reduto Online");
  console.log(`[SICOR] Servidor configurado: ${GUILD_ID}`);
  console.log("====================================");
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (error) {
    console.error("[SICOR] Erro ao processar interação:", error);

    const message =
      "Ocorreu um erro ao processar sua solicitação. Tente novamente ou contate o Alto-Comando.";

    try {
      if (interaction.deferred) {
        await interaction.editReply({
          content: message,
          embeds: [],
          components: []
        });
      } else if (interaction.replied) {
        await interaction.followUp({
          content: message,
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: message,
          ephemeral: true
        });
      }
    } catch (replyError) {
      console.error("[SICOR] Não foi possível enviar a mensagem de erro:", replyError);
    }
  }
});

// ==================================================
// INICIALIZAÇÃO
// ==================================================

async function start() {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error("[SICOR] Não foi possível iniciar o sistema:", error);
    process.exit(1);
  }
}

process.on("unhandledRejection", (error) => {
  console.error("[SICOR] Erro não tratado:", error);
});

start();
