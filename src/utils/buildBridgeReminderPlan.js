'use strict';

/**
 * buildBridgeReminderPlan.js — bridge reminder plan builder
 *
 * Extracted from the inline closure in planSkills.js.
 * Generates:
 *   • skill.md with ## Commands + OAuth frontmatter + SMS gateway email
 *   • A pre-cached bridge.<skillName>.json execution plan so LLM is never
 *     invoked at cron fire time.
 *
 * Returns { skillMd, reminderPlan }.
 *
 * @param {string} skillName         — dot-name of the skill (e.g. reminder.you.watch.incoming)
 * @param {string} cronExpr          — cron expression (e.g. "0 9 * * *")
 * @param {string} bridgeInstruction — the user's instruction text for the bridge task
 * @param {object} ctx               — runtime context pulled from stategraph state
 *   ctx.homeDir                 — process home directory
 *   ctx.smsGatewayTarget        — { email, name } or null
 *   ctx.resolvedSelfContext     — { email } or null
 *   ctx.installedSkillsList     — [{ name }] array
 *   ctx.preflightCliMap         — { service: { hasCli: bool } }
 *   ctx.logger                  — logger instance
 */
function buildBridgeReminderPlan(skillName, cronExpr, bridgeInstruction, ctx) {
  const {
    homeDir,
    smsGatewayTarget,
    resolvedSelfContext,
    installedSkillsList = [],
    preflightCliMap = {},
    logger,
  } = ctx;

  const _gwEmail       = smsGatewayTarget?.email || null;
  const _selfEmail     = resolvedSelfContext?.email || null;
  const _deliveryEmail = _gwEmail || _selfEmail || null;
  const _label    = skillName.split('.').slice(1).join('.');
  const _skillDir = `${homeDir}/.thinkdrop/skills/${skillName}`;
  const _plansDir = `${homeDir}/.thinkdrop/plans`;

  // ── Email agent registry ─────────────────────────────────────────────────────
  const _BRIDGE_EMAIL_AGENTS = [
    {
      agentName: 'gmail.agent',
      startUrl: 'https://mail.google.com/mail/u/0/#inbox',
      oauth: 'google',
      oauthScopes: 'google=https://www.googleapis.com/auth/gmail.send',
      buildAgentTask: (toEmail, subject) =>
        `In Gmail, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'outlook.agent',
      startUrl: 'https://outlook.live.com/mail/0/inbox',
      oauth: 'microsoft',
      oauthScopes: 'microsoft=Mail.Send',
      buildAgentTask: (toEmail, subject) =>
        `In Outlook, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'yahoo.agent',
      startUrl: 'https://mail.yahoo.com/',
      oauth: 'yahoo',
      oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `In Yahoo Mail, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'protonmail.agent',
      startUrl: 'https://mail.proton.me/',
      oauth: 'proton',
      oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `In Proton Mail, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'fastmail.agent',
      startUrl: 'https://app.fastmail.com/mail/',
      oauth: 'fastmail',
      oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `In Fastmail, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'zohomail.agent',
      startUrl: 'https://mail.zoho.com/',
      oauth: 'zoho',
      oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `In Zoho Mail, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'icloud.agent',
      startUrl: 'https://www.icloud.com/mail/',
      oauth: 'apple',
      oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `In iCloud Mail, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'aol.agent',
      startUrl: 'https://mail.aol.com/',
      oauth: 'aol',
      oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `In AOL Mail, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'tutanota.agent',
      startUrl: 'https://app.tuta.com/',
      oauth: 'tutanota',
      oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `In Tuta (Tutanota), compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
    {
      agentName: 'hey.agent',
      startUrl: 'https://app.hey.com/',
      oauth: 'hey',
      oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `In HEY Mail, compose a new email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    },
  ];

  const _BRIDGE_API_SENDERS = [
    {
      agentName: 'resend.agent',
      buildAgentTask: (toEmail, subject) =>
        `Use the Resend CLI to send an email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Body: the gathered content.`,
    },
    {
      agentName: 'sendgrid.agent',
      buildAgentTask: (toEmail, subject) =>
        `Use the SendGrid CLI to send an email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Body: the gathered content.`,
    },
    {
      agentName: 'mailgun.agent',
      buildAgentTask: (toEmail, subject) =>
        `Use the Mailgun CLI to send an email. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Body: the gathered content.`,
    },
  ];

  const _BRIDGE_SERVICE_ALIASES = { verizon: 'yahoo', hotmail: 'outlook', live: 'outlook', msn: 'outlook', tuta: 'tutanota' };

  const _knownSvcRe = /\b(gmail|outlook|yahoo|aol|verizon|protonmail|fastmail|zohomail|zoho|icloud|hotmail|live|msn|tutanota|tuta|hey|resend|sendgrid|mailgun)\b/i;
  let _mentionedService = (_knownSvcRe.exec(bridgeInstruction)?.[1] || '').toLowerCase();
  if (!_mentionedService) {
    const _genericSvcMatch = /\bmy\s+(\w+)\s+(?:account|email|inbox|mail)\b/i.exec(bridgeInstruction)
                            || /\b(\w+)\s+(?:account|email|inbox|mail)\b/i.exec(bridgeInstruction);
    if (_genericSvcMatch) {
      const _candidate = _genericSvcMatch[1].toLowerCase();
      const _NOT_SVC = new Set(['my','the','a','an','email','some','any','this','that','your','our','new','old','main','primary','secondary','work','personal']);
      if (!_NOT_SVC.has(_candidate) && _candidate.length >= 3) _mentionedService = _candidate;
    }
  }
  if (_mentionedService && _BRIDGE_SERVICE_ALIASES[_mentionedService]) {
    _mentionedService = _BRIDGE_SERVICE_ALIASES[_mentionedService];
  }

  const _mentionedAgentId   = _mentionedService ? `${_mentionedService}.agent` : null;
  const _mentionedInstalled = _mentionedAgentId ? installedSkillsList.some(s => s.name === _mentionedAgentId) : false;
  const _needsBuildAgent    = !!(_mentionedAgentId && !_mentionedInstalled);

  const _bridgeEmailKwRe  = /\b(email|gmail|send.*message|sms|text.*me|text.*summary|carrier.*gateway|@vtext|@txt|@mms)\b/i;
  const _bridgeNeedsEmail = _bridgeEmailKwRe.test(bridgeInstruction);

  const _bridgeApiSender = _mentionedService
    ? _BRIDGE_API_SENDERS.find(e => e.agentName === _mentionedAgentId)
    : null;

  let _bridgeDetectedAgent;
  if (!_bridgeNeedsEmail) {
    _bridgeDetectedAgent = null;
  } else if (_mentionedService) {
    const _knownEntry = _BRIDGE_EMAIL_AGENTS.find(e => e.agentName === _mentionedAgentId);
    _bridgeDetectedAgent = _knownEntry || {
      agentName: _mentionedAgentId, startUrl: null, oauth: _mentionedService, oauthScopes: '',
      buildAgentTask: (toEmail, subject) =>
        `Compose and send an email via ${_mentionedService}. To: ${toEmail || '[RECIPIENT_EMAIL]'}. Subject: ${subject || '(digest)'}. Paste the gathered content into the body. Send it.`,
    };
  } else {
    _bridgeDetectedAgent = _BRIDGE_EMAIL_AGENTS.find(e => installedSkillsList.some(s => s.name === e.agentName))
      || _BRIDGE_EMAIL_AGENTS[0];
  }

  const _bridgeOauthFmLines = (_bridgeDetectedAgent && _bridgeDetectedAgent.oauth && !_bridgeApiSender)
    ? [`oauth: ${_bridgeDetectedAgent.oauth}`, `oauth_scopes: ${_bridgeDetectedAgent.oauthScopes}`]
    : [];

  const _agentTaskStr = _bridgeDetectedAgent
    ? _bridgeDetectedAgent.buildAgentTask(_gwEmail || _deliveryEmail, `${_label} digest`)
    : null;

  const _bridgeBodyLines = _agentTaskStr
    ? [
        '## Plan',
        '1. Gather the content described in the instruction using the appropriate agent or data source.',
        `2. Send the result via email: ${_agentTaskStr}`,
      ]
    : [
        '## Plan',
        `At fire time, ThinkDrop executes: "${bridgeInstruction.replace(/[\n\r]/g, ' ').replace(/"/g, "'")}"`,
      ];

  const _safeInstruction = bridgeInstruction.replace(/[\n\r]/g, ' ').replace(/"/g, "'");
  const skillMd = [
    `---`,
    `name: ${skillName}`,
    `schedule: "${cronExpr}"`,
    `type: bridge`,
    `title: ${_label}`,
    `instruction: ${_safeInstruction}`,
    `description: Scheduled task — ${_safeInstruction.substring(0, 150)}`,
    ..._bridgeOauthFmLines,
    ...(_gwEmail ? [`sms_gateway_email: ${_gwEmail}`, `sms_gateway_name: ${smsGatewayTarget?.name || 'me'}`] : []),
    ...(!_gwEmail && _deliveryEmail ? [`delivery_email: ${_deliveryEmail}`] : []),
    `---`,
    ``,
    ..._bridgeBodyLines,
  ].join('\n');

  const setupScript = [
    `mkdir -p "${_skillDir}"`,
    `cat > "${_skillDir}/skill.md" << 'SKILL_EOF'`,
    skillMd,
    `SKILL_EOF`,
    `echo "✅ Bridge skill written: ${skillName}"`,
  ].join('\n');

  const _inboxUrl = _bridgeDetectedAgent?.startUrl || null;

  const _emailAgentNames = new Set(_BRIDGE_EMAIL_AGENTS.map(e => e.agentName.replace('.agent', '')));
  const _dataSourceService = Object.keys(preflightCliMap).find(
    svc => !_emailAgentNames.has(svc) && new RegExp(`\\b${svc}\\b`, 'i').test(bridgeInstruction)
  ) || null;
  const _mentionedHasCli = !!(_dataSourceService && preflightCliMap[_dataSourceService]?.hasCli);

  let _execPlan = null;
  if (_mentionedHasCli && _bridgeApiSender && _deliveryEmail) {
    _execPlan = [
      {
        skill: 'cli.agent',
        description: `Fetch data from ${_dataSourceService}`,
        args: {
          action: 'run',
          agentId: `${_dataSourceService}.agent`,
          task: bridgeInstruction + '. In your done summary write ONLY the human-readable findings formatted as clean email body content — the actual data and results only. Do NOT include CLI commands, implementation notes, technical details, or future automation suggestions.',
        },
      },
      {
        skill: 'cli.agent',
        description: `Send digest email to ${_deliveryEmail}`,
        args: {
          action: 'run',
          agentId: _bridgeApiSender.agentName,
          task: _bridgeApiSender.buildAgentTask(_deliveryEmail, `${_label} digest`) + ' Body content: {{PREV_OUTPUT}}',
        },
      },
    ];
  } else if (_mentionedHasCli && _bridgeDetectedAgent) {
    const _toEmail = _deliveryEmail || 'yourself (the currently signed-in account)';
    _execPlan = [
      {
        skill: 'cli.agent',
        description: `Fetch data from ${_dataSourceService}`,
        args: {
          action: 'run',
          agentId: `${_dataSourceService}.agent`,
          task: bridgeInstruction + '. In your done summary write ONLY the human-readable findings formatted as clean email body content — the actual data and results only. Do NOT include CLI commands, implementation notes, technical details, or future automation suggestions.',
        },
      },
      {
        skill: 'browser.agent',
        description: `Send digest email to ${_toEmail}`,
        args: {
          action: 'run',
          agentId: _bridgeDetectedAgent.agentName,
          ...(_inboxUrl ? { url: _inboxUrl } : {}),
          task: _bridgeDetectedAgent.buildAgentTask(_toEmail, `${_label} digest`) + ' Body: {{PREV_OUTPUT}}',
        },
      },
    ];
  } else if (_mentionedHasCli && !_bridgeDetectedAgent) {
    _execPlan = [{
      skill: 'cli.agent',
      description: _label,
      args: { action: 'run', agentId: `${_dataSourceService}.agent`, task: bridgeInstruction },
    }];
  } else if (_bridgeDetectedAgent) {
    const _execPlanTask = _deliveryEmail
      ? _bridgeDetectedAgent.buildAgentTask(_deliveryEmail, `${_label} digest`) + ` First, ${bridgeInstruction}.`
      : bridgeInstruction;
    _execPlan = [{
      skill: 'browser.agent',
      description: _label,
      args: {
        action: 'run',
        agentId: _bridgeDetectedAgent.agentName,
        ...(_inboxUrl ? { url: _inboxUrl } : {}),
        task: _execPlanTask,
      },
    }];
  }

  const _planWriteScript = _execPlan ? [
    `mkdir -p "${_plansDir}"`,
    `cat > "${_plansDir}/bridge.${skillName}.json" << 'EXECPLAN_EOF'`,
    JSON.stringify(_execPlan, null, 2),
    `EXECPLAN_EOF`,
    `echo "✅ Pre-cached execution plan: ${skillName}"`,
  ].join('\n') : null;

  const reminderPlan = [
    ...(_needsBuildAgent ? [{
      skill: 'browser.agent',
      description: `Set up ${_mentionedService} account`,
      args: { action: 'build_agent', service: _mentionedService },
    }] : []),
    {
      skill: 'shell.run',
      description: `Write bridge skill.md for "${_label}" (AI task — ${cronExpr})`,
      args: { cmd: 'bash', argv: ['-c', setupScript] },
    },
    {
      skill: 'skill.install',
      description: `Register ${skillName} so SkillScheduler picks up the cron`,
      args: { skillPath: `${homeDir}/.thinkdrop/skills/${skillName}/skill.md` },
    },
    {
      skill: 'shell.run',
      description: `Sync SkillScheduler to activate the cron immediately`,
      args: { cmd: 'bash', argv: ['-c', `curl -s -X POST http://127.0.0.1:3007/skill.schedule/sync && echo "✅ node-cron activated: ${skillName}"`] },
    },
    ...(_planWriteScript ? [{
      skill: 'shell.run',
      description: `Pre-cache execution plan for ${skillName}`,
      args: { cmd: 'bash', argv: ['-c', _planWriteScript] },
    }] : []),
  ];

  if (logger) {
    if (_needsBuildAgent) {
      logger.info(`[buildBridgeReminderPlan] [+build-agent]: "${_label}" agent=${_mentionedAgentId}`);
    } else if (_bridgeDetectedAgent) {
      logger.info(`[buildBridgeReminderPlan] [+email-api]: "${_label}" agent=${_bridgeDetectedAgent.agentName} gwEmail=${_gwEmail || 'none'}`);
    } else {
      logger.info(`[buildBridgeReminderPlan] [generic]: "${_label}"`);
    }
  }

  return { skillMd, reminderPlan };
}

module.exports = { buildBridgeReminderPlan };
