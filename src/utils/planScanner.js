'use strict';

/**
 * planScanner.js
 *
 * Security utility for plan.md files:
 *   - scan()         — detect & replace sensitive data with {{SENSITIVE_N}} placeholders
 *   - validate()     — parse & validate plan.md structure, return errors/warnings
 *   - injectSecrets()— restore real values from keytar/memory into a plan at execution time
 *
 * Sensitive data classification:
 *   HIGH (→ keytar): API keys/tokens, passwords, private keys, credit cards, SSNs
 *   MEDIUM (→ user-memory): email addresses, phone numbers, URLs with credentials
 */

const KEYTAR_SERVICE = 'thinkdrop';

// ── Sensitive data patterns ────────────────────────────────────────────────
// Each entry: { name, regex, type: 'high'|'medium', description }
// Patterns are applied in order — first match wins per value.
const SENSITIVE_PATTERNS = [
  // API keys / tokens — sk-*, pk-*, Bearer tokens, hex/base64 secrets
  {
    name: 'api_key_sk',
    regex: /\b(sk-[A-Za-z0-9_\-]{20,80})\b/g,
    type: 'high',
    description: 'API key (sk- prefix)',
  },
  {
    name: 'api_key_pk',
    regex: /\b(pk-[A-Za-z0-9_\-]{20,80})\b/g,
    type: 'high',
    description: 'API key (pk- prefix)',
  },
  {
    name: 'bearer_token',
    regex: /Bearer\s+([A-Za-z0-9_\-\.]{20,200})/gi,
    type: 'high',
    description: 'Bearer token',
  },
  // Password/secret labels: "password: xxx", "pwd=xxx", "secret: xxx"
  {
    name: 'password_label',
    regex: /(?:^|\s)(?:password|passwd|pwd|secret|passphrase|pass)\s*[:=]\s*(\S+)/gim,
    type: 'high',
    description: 'Password/secret value',
  },
  // Private keys (PEM headers stripped, multiline handled by caller)
  {
    name: 'private_key_header',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    type: 'high',
    description: 'Private key block',
  },
  // Credit card numbers (Luhn-validated below)
  {
    name: 'credit_card',
    regex: /\b(\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4})\b/g,
    type: 'high',
    description: 'Credit card number',
    validate: luhnCheck,
  },
  // SSN
  {
    name: 'ssn',
    regex: /\b(\d{3}-\d{2}-\d{4})\b/g,
    type: 'high',
    description: 'SSN',
  },
  // Hex tokens 32+ chars (API secrets, signing keys)
  {
    name: 'hex_token',
    regex: /\b([0-9a-fA-F]{32,64})\b/g,
    type: 'high',
    description: 'Hex token/secret',
  },
  // Email addresses → medium (non-sensitive PII, stored in user-memory)
  {
    name: 'email',
    regex: /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g,
    type: 'medium',
    description: 'Email address',
  },
  // Phone numbers (E.164 + US formats)
  {
    name: 'phone',
    regex: /(?<!\d)(\+?1?\s*[\(\-]?\d{3}[\)\-\s]?\s*\d{3}[\-\s]?\d{4})(?!\d)/g,
    type: 'medium',
    description: 'Phone number',
  },
];

// ── Luhn check ─────────────────────────────────────────────────────────────
function luhnCheck(str) {
  const digits = str.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let isEven = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }
  return sum % 10 === 0;
}

// ── Plan.md frontmatter / step parser ─────────────────────────────────────
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fm[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

function parseSteps(content) {
  const steps = [];
  // Match ### Step N — Title blocks
  const stepRegex = /### Step (\d+)[^\n]*\n([\s\S]*?)(?=### Step \d+|$)/g;
  let m;
  while ((m = stepRegex.exec(content)) !== null) {
    const num = parseInt(m[1], 10);
    const body = m[2];
    const fields = {};
    // Parse - **Field**: value lines
    const fieldRegex = /- \*\*([^*]+)\*\*:\s*(.+)/g;
    let fm;
    while ((fm = fieldRegex.exec(body)) !== null) {
      fields[fm[1].trim().toLowerCase()] = fm[2].trim();
    }
    steps.push({ num, body, fields });
  }
  return steps;
}

// ── scan() ─────────────────────────────────────────────────────────────────
/**
 * Scan plan content for sensitive data, replace with {{SENSITIVE_N}} placeholders.
 * Returns { sanitized: string, secrets: Map<string, { type, name, value, storage }> }
 *
 * secrets Map key is the placeholder name (e.g. 'SENSITIVE_1').
 * The caller is responsible for persisting the secrets Map to keytar/memory.
 */
function scan(content) {
  let sanitized = content;
  const secrets = new Map(); // placeholder → { type, name, value, storage, description }
  let counter = 1;

  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset lastIndex between runs
    pattern.regex.lastIndex = 0;

    sanitized = sanitized.replace(pattern.regex, (match, captured) => {
      // For credit cards, validate via Luhn before redacting
      if (pattern.validate && !pattern.validate(captured || match)) {
        return match; // not actually a credit card — leave it
      }

      const value = captured || match;

      // Deduplicate — if the same value was already captured, reuse placeholder
      for (const [placeholder, info] of secrets.entries()) {
        if (info.value === value) return `{{${placeholder}}}`;
      }

      const placeholder = `SENSITIVE_${counter++}`;
      secrets.set(placeholder, {
        type: pattern.type,
        name: pattern.name,
        value,
        storage: pattern.type === 'high' ? 'keytar' : 'memory',
        description: pattern.description,
      });

      return `{{${placeholder}}}`;
    });

    // Reset after replace()
    pattern.regex.lastIndex = 0;
  }

  return { sanitized, secrets };
}

// ── validate() ────────────────────────────────────────────────────────────
/**
 * Validate plan.md structure.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
function validate(content) {
  const errors = [];
  const warnings = [];

  if (!content || !content.trim()) {
    return { valid: false, errors: ['Plan content is empty'], warnings: [] };
  }

  // 1. Frontmatter
  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push('Missing YAML frontmatter block (--- ... ---) at top of file');
  } else {
    if (!fm.id)              warnings.push('Frontmatter missing "id" field');
    if (!fm.created)         warnings.push('Frontmatter missing "created" field');
    if (!fm.original_prompt) warnings.push('Frontmatter missing "original_prompt" field');
    if (!fm.status)          warnings.push('Frontmatter missing "status" field');
  }

  // 2. Must have a # Plan title
  if (!/^# Plan:/m.test(content)) {
    errors.push('Missing plan title (expected "# Plan: ..." heading)');
  }

  // 3. Must have ## Steps section
  if (!/^## Steps/m.test(content)) {
    errors.push('Missing "## Steps" section');
  }

  // 4. Validate steps
  const steps = parseSteps(content);
  if (steps.length === 0) {
    errors.push('No steps found — add at least one "### Step N — Title" section');
  }

  const validIntents = new Set([
    'command_automate', 'memory_retrieve', 'memory_store', 'web_search',
    'general_knowledge', 'screen_intelligence', 'greeting',
  ]);
  const validStatuses = new Set(['⬜ pending', '🔄 running', '✅ done', '❌ failed', '⏭ skipped']);

  const stepNums = new Set();
  for (const step of steps) {
    if (stepNums.has(step.num)) {
      errors.push(`Duplicate step number: ${step.num}`);
    }
    stepNums.add(step.num);

    const { fields } = step;

    if (!fields.intent) {
      errors.push(`Step ${step.num}: missing required "Intent" field`);
    } else if (!validIntents.has(fields.intent)) {
      warnings.push(`Step ${step.num}: unrecognized intent "${fields.intent}" (expected one of: ${[...validIntents].join(', ')})`);
    }

    if (!fields.status) {
      warnings.push(`Step ${step.num}: missing "Status" field — defaulting to ⬜ pending`);
    } else {
      const statusContent = fields.status;
      if (!validStatuses.has(statusContent)) {
        warnings.push(`Step ${step.num}: unrecognized status "${statusContent}"`);
      }
    }

    // Check for accidental raw sensitive data (phone/email not yet scanned)
    const bodyResult = scan(step.body);
    if (bodyResult.secrets.size > 0) {
      for (const [, info] of bodyResult.secrets.entries()) {
        warnings.push(`Step ${step.num}: detected unsanitized ${info.description} — save the plan to auto-redact`);
      }
    }
  }

  // 5. Check step ordering (numbers should be sequential starting from 1)
  const nums = [...stepNums].sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      warnings.push(`Non-sequential step numbers detected — steps should be numbered starting from 1`);
      break;
    }
  }

  // 6. Check {{VAR}} placeholders that aren't in the Variables section
  const varSection = content.match(/## Variables\n([\s\S]*?)(?=##|$)/);
  const declaredVars = new Set();
  if (varSection) {
    const varRegex = /`\{\{([^}]+)\}\}`/g;
    let vm;
    while ((vm = varRegex.exec(varSection[1])) !== null) {
      declaredVars.add(vm[1]);
    }
  }
  // Find all {{VAR}} usage in steps section
  const stepsContent = content.split('## Steps')[1] || '';
  const usedVarRegex = /\{\{([^}]+)\}\}/g;
  let uv;
  while ((uv = usedVarRegex.exec(stepsContent)) !== null) {
    const varName = uv[1];
    if (!varName.startsWith('SENSITIVE_') && !declaredVars.has(varName)) {
      warnings.push(`Variable "{{${varName}}}" used in steps but not declared in ## Variables section`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── injectSecrets() ────────────────────────────────────────────────────────
/**
 * For execution time: restore {{SENSITIVE_N}} and {{VAR}} placeholders with real values.
 * Pulls from keytar (for HIGH-type secrets) and mcpAdapter/memory (for MEDIUM-type).
 *
 * @param {string}   content     — plan content (may contain {{SENSITIVE_N}} + {{USER_EMAIL}} etc.)
 * @param {object}   options
 * @param {Function} options.keytarGet    — async (service, key) → string|null
 * @param {object}   options.mcpAdapter   — to call memory.search for medium-type PII
 * @param {object}   options.logger
 * @returns {Promise<string>}     — content with all placeholders substituted
 */
async function injectSecrets(content, { keytarGet, mcpAdapter, logger } = {}) {
  const log = logger || console;
  let result = content;

  // 1. Inject keytar-stored SENSITIVE_N values
  const sensitiveRegex = /\{\{(SENSITIVE_\d+)\}\}/g;
  const keytarMatches = [...content.matchAll(sensitiveRegex)];

  for (const [, key] of keytarMatches) {
    if (typeof keytarGet !== 'function') break;
    try {
      const value = await keytarGet(KEYTAR_SERVICE, key);
      if (value) {
        result = result.split(`{{${key}}}`).join(value);
      } else {
        log.warn(`[PlanScanner:injectSecrets] No keytar value found for ${key}`);
      }
    } catch (err) {
      log.warn(`[PlanScanner:injectSecrets] keytar lookup failed for ${key}: ${err.message}`);
    }
  }

  // 2. Inject memory-resolved variables: {{USER_EMAIL}}, {{USER_PHONE}}, etc.
  //    Pattern: {{WORD}} where WORD is all-caps with underscores
  const memVarRegex = /\{\{([A-Z][A-Z0-9_]+)\}\}/g;
  const memMatches = [...result.matchAll(memVarRegex)];

  for (const [, varName] of memMatches) {
    if (varName.startsWith('SENSITIVE_')) continue; // already handled above

    if (!mcpAdapter) continue;
    try {
      // Map variable name to memory search query
      const query = varName.toLowerCase().replace(/_/g, ' ');
      const response = await mcpAdapter.callService('user-memory', 'memory.search', {
        query,
        userId: 'default_user',
        limit: 1,
      });
      const memories = response?.data?.memories || response?.memories || [];
      if (memories.length > 0) {
        const memText = memories[0].source_text || memories[0].extracted_text || '';
        // Extract the actual value from memory text (e.g. "My email is foo@bar.com" → "foo@bar.com")
        const emailMatch = memText.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/);
        const phoneMatch = memText.match(/\+?1?\s*[\(\-]?\d{3}[\)\-\s]?\s*\d{3}[\-\s]?\d{4}/);
        let extracted = null;
        if (varName.includes('EMAIL') && emailMatch) extracted = emailMatch[1];
        else if (varName.includes('PHONE') && phoneMatch) extracted = phoneMatch[0].trim();
        else extracted = memText.slice(0, 200);

        if (extracted) {
          result = result.split(`{{${varName}}}`).join(extracted);
          log.debug(`[PlanScanner:injectSecrets] Resolved {{${varName}}} from memory`);
        }
      }
    } catch (err) {
      log.warn(`[PlanScanner:injectSecrets] Memory lookup failed for {{${varName}}}: ${err.message}`);
    }
  }

  return result;
}

// ── storeSecrets() ─────────────────────────────────────────────────────────
/**
 * Persist the secrets map returned by scan() to keytar and/or user-memory.
 *
 * @param {Map}    secrets     — from scan()
 * @param {object} options
 * @param {Function} options.keytarSet    — async (service, key, value)
 * @param {object}   options.mcpAdapter   — for medium-type memory storage
 * @param {object}   options.logger
 * @returns {Promise<{ stored: string[], failed: string[] }>}
 */
async function storeSecrets(secrets, { keytarSet, mcpAdapter, userId = 'default_user', logger } = {}) {
  const log = logger || console;
  const stored = [];
  const failed = [];

  for (const [placeholder, info] of secrets.entries()) {
    try {
      if (info.storage === 'keytar') {
        if (typeof keytarSet !== 'function') {
          failed.push(placeholder);
          continue;
        }
        await keytarSet(KEYTAR_SERVICE, placeholder, info.value);
        log.debug(`[PlanScanner:storeSecrets] Stored ${placeholder} (${info.description}) in keytar`);
        stored.push(placeholder);
      } else {
        // medium — store in user-memory as personal_profile
        if (!mcpAdapter) {
          failed.push(placeholder);
          continue;
        }
        const memorySentence = buildMemorySentence(info);
        await mcpAdapter.callService('user-memory', 'memory.store', {
          text: memorySentence,
          type: 'personal_profile',
          userId,
        });
        // Also store the raw value in keytar under the placeholder key so injectSecrets can find it
        if (typeof keytarSet === 'function') {
          await keytarSet(KEYTAR_SERVICE, placeholder, info.value);
        }
        log.debug(`[PlanScanner:storeSecrets] Stored ${placeholder} (${info.description}) in memory`);
        stored.push(placeholder);
      }
    } catch (err) {
      log.warn(`[PlanScanner:storeSecrets] Failed to store ${placeholder}: ${err.message}`);
      failed.push(placeholder);
    }
  }

  return { stored, failed };
}

function buildMemorySentence(info) {
  switch (info.name) {
    case 'email':  return `My email address is ${info.value}`;
    case 'phone':  return `My phone number is ${info.value}`;
    default:       return `${info.description}: ${info.value}`;
  }
}

// ── parseStepsPublic() ─────────────────────────────────────────────────────
/**
 * Public parser: returns structured steps from a plan.md string.
 * Used by planExecutor to iterate over steps.
 *
 * @returns Array<{ num, title, intent, action, skills, dependsOn, isSync, isLongRunning, status, result, body }>
 */
function parseStepsPublic(content) {
  const raw = parseSteps(content);
  return raw.map((s) => {
    const f = s.fields;
    const titleMatch = content.match(new RegExp(`### Step ${s.num}\\s*[—\\-]?\\s*([^\\n]+)`));
    const title = titleMatch ? titleMatch[1].trim() : `Step ${s.num}`;

    // Parse "Depends on" field — supports "Step 1", "Steps 1-3", "Step 1 (email), Step 2"
    const dependsOnRaw = f['depends on'] || f.depends || '';
    const dependsOn = [];
    const depNums = dependsOnRaw.match(/\bStep\s+(\d+)/gi) || [];
    for (const d of depNums) {
      const n = parseInt(d.replace(/\D/g, ''), 10);
      if (!isNaN(n)) dependsOn.push(n);
    }

    // Parse skills
    const skillsRaw = f.skills || '';
    const skills = skillsRaw
      ? skillsRaw.split(/[|,]/).map((s) => s.trim()).filter(Boolean)
      : [];

    const isSync = f.issync === 'true' || f['isSync'] === 'true' || f.issync === 'true';
    const isLongRunning = f.islongrunning === 'true' || f['isLongRunning'] === 'true';

    return {
      num: s.num,
      title,
      intent: (f.intent || 'general_knowledge').trim(),
      action: (f.action || '').trim(),
      query: (f.query || '').trim(),
      skills,
      dependsOn,
      isSync,
      isLongRunning,
      status: (f.status || '⬜ pending').trim(),
      result: (f.result || '').replace(/^—$/, '').trim(),
      body: s.body,
    };
  });
}

// ── updateStepStatus() ─────────────────────────────────────────────────────
/**
 * Update the **Status** and optionally **Result** of a step in plan.md content.
 * Returns the updated content string.
 *
 * @param {string} content  — full plan.md content
 * @param {number} stepNum  — 1-based step number
 * @param {string} status   — one of the status emoji strings
 * @param {string} [result] — optional result text to write into the Result field
 * @returns {string}
 */
function updateStepStatus(content, stepNum, status, result) {
  let updated = content;

  // Replace - **Status**: <anything> in the correct step block
  const stepSectionRegex = new RegExp(
    `(### Step ${stepNum}[^\\n]*\\n[\\s\\S]*?)(- \\*\\*Status\\*\\*: )[^\\n]+(\\n)`,
    'g'
  );
  updated = updated.replace(stepSectionRegex, (match, before, statusLabel, newline) => {
    return before + statusLabel + status + newline;
  });

  // Update Result field if provided
  if (result !== undefined && result !== null) {
    const resultRegex = new RegExp(
      `(### Step ${stepNum}[^\\n]*\\n[\\s\\S]*?)(- \\*\\*Result\\*\\*: )[^\\n]+(\\n)`,
      'g'
    );
    const resultSnippet = result.slice(0, 300).replace(/\n/g, ' ');
    updated = updated.replace(resultRegex, (match, before, resultLabel, newline) => {
      return before + resultLabel + (resultSnippet || '(no result)') + newline;
    });
  }

  return updated;
}

// ── updateFrontmatterStatus() ──────────────────────────────────────────────
/**
 * Update the top-level status field in plan frontmatter.
 */
function updateFrontmatterStatus(content, status) {
  return content.replace(
    /^(status:\s*)[^\n]+/m,
    `$1${status}`
  );
}

module.exports = {
  scan,
  validate,
  injectSecrets,
  storeSecrets,
  parseSteps: parseStepsPublic,
  updateStepStatus,
  updateFrontmatterStatus,
};
