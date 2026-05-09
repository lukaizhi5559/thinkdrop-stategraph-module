/**
 * ParseSkill Node
 *
 * Runs AFTER resolveReferences, BEFORE parseIntent.
 *
 * Purpose: detect whether the user's (resolved) message directly invokes
 * an installed external skill by name, and short-circuit the intent pipeline.
 *
 * Two matching strategies:
 *
 * 1. EXACT NAME MATCH — tokenizes the message and checks if it starts with or
 *    contains a registered skill name from the installed_skills DB.
 *    e.g. "check.weather.daily New York" → matches "check.weather.daily"
 *
 * 2. NATURAL LANGUAGE MATCH — checks if the message contains the skill name
 *    as a phrase, handling dot → space variations and common prefixes.
 *    e.g. "run check weather daily for NYC" → matches "check.weather.daily"
 *
 * On match: sets state.matchedSkillName + intent=command_automate so planSkills
 * can inject the skill contract as RAG context.
 *
 * On no match: passes through unchanged so resolveReferences → parseIntent
 * handles classification as normal.
 *
 * Graceful degradation: if user-memory service is unavailable, passes through.
 */

const SEMANTIC_SYSTEM_PROMPT = `You are a strict skill-matching assistant. Given a user's request and a list of installed skills, determine if any skill EXACTLY matches what the user wants to do.

Rules:
- Only match if the skill's purpose DIRECTLY covers the user's request — same service, same action type, same intent.
- Do NOT match on loose thematic similarity. Sharing a general domain does NOT qualify.
- IMPORTANT: Even if the user says "I need to create" or "I want to build" a skill, if an existing installed skill ALREADY covers the described capability, return that skill name.

## Recurring vs one-off — CRITICAL distinction:
- A skill that creates ONE Google Calendar event (gcal.event) does NOT match requests for recurring local reminders like "every morning", "daily at 6am", "remind me every day".
- Recurring/scheduled tasks that don't explicitly say "Google Calendar" or "add to my calendar" should NOT match calendar event creation skills.
- Only match a calendar skill if the user explicitly mentions Google Calendar, or says "add/create a calendar event/appointment".

## Matching examples:
- "Schedule my cold plunge every morning at 6am" → null (local recurring reminder, not a calendar event)
- "Add a dentist appointment to my Google Calendar" → gcal.event ✅
- "Remind me daily at 7am" → null (local OS reminder, not a calendar event)
- "Create a calendar event for the team meeting on Friday" → gcal.event ✅
- "Send Sarah a text" → sms/clicksend skill if installed ✅
- "Check the weather" → weather skill if installed ✅

Output format — ONLY these two formats, nothing else:
skill-name|HIGH
null

Return "null" when there is NO clear match or when confidence is not HIGH. Never return MEDIUM or LOW matches.`;

// Signals that the user wants a recurring/background task (not a one-off event)
const RECURRING_SIGNALS_RE = /\b(every\s+(morning|day|night|evening|week|month|hour|\d)|daily|weekly|monthly|alarm|each\s+(morning|day|night|evening|week)|remind\s+me\s+(daily|every)|recurring|repeat(ing)?|on\s+a\s+(daily|weekly|\w+)\s+schedule|at\s+\d{1,2}(:\d{2})?\s*(am|pm)\s+(every|daily|each))\b/i;
// Skill name fragments that indicate a one-shot event-creation skill (not a daemon)
const ONE_SHOT_EVENT_MARKERS = ['calendar', '.event', 'booking', 'meeting', 'webex', 'zoom.schedule'];

// Patterns that indicate the user wants to CREATE a skill (phrasing, not intent)
const WANTS_TO_CREATE_RE = /\b(create|build|make|write|add|install|set up|setup)\b.{0,40}\b(skill|ability|feature|capability|automation|tool)\b|\bneed (a |to )?(create|build|make|have)\b|\bdon't have\b|\bdoesn'?t exist\b/i;

module.exports = async function parseSkill(state) {
  const { mcpAdapter, message, resolvedMessage, llmBackend } = state;
  const logger = state.logger || console;

  // Fast-path: skill plan already built (post-approval re-entry) — nothing to match
  if (state._skillPlan && Array.isArray(state._skillPlan) && state._skillPlan.length > 0) {
    logger.info('[Node:ParseSkill] _skillPlan pre-built — skipping (post-approval fast-path)');
    return state;
  }

  const classifyMessage = (resolvedMessage || message || '').trim();

  if (!classifyMessage) return state;

  // No adapter → pass through
  if (!mcpAdapter) {
    logger.debug('[Node:ParseSkill] No mcpAdapter — skipping');
    return state;
  }

  let installedSkills = [];
  try {
    const result = await mcpAdapter.callService('user-memory', 'skill.listNames', {}, { timeoutMs: 3000 });
    const data = result?.data || result;
    installedSkills = data?.results || [];
  } catch (err) {
    logger.debug(`[Node:ParseSkill] Could not fetch installed skills: ${err.message} — skipping`);
    return state;
  }

  if (installedSkills.length === 0) {
    logger.debug('[Node:ParseSkill] No installed skills — skipping');
    return state;
  }

  // ── Merge filesystem skill dirs as canonical source of truth ──────────────────
  // User-memory DB names may diverge from actual directory names on disk (truncation,
  // prefix differences). Read ~/.thinkdrop/skills/ directly and add any dir that has
  // an index.cjs but isn't already in the DB list so substring rescue always hits
  // the exact on-disk name.
  {
    const _fsModule = require('fs');
    const _pathModule = require('path');
    const _osModule = require('os');
    const SKILLS_BASE = _pathModule.join(_osModule.homedir(), '.thinkdrop', 'skills');
    try {
      const _fsDirs = _fsModule.readdirSync(SKILLS_BASE).filter(d =>
        _fsModule.existsSync(_pathModule.join(SKILLS_BASE, d, 'index.cjs'))
      );
      const _dbNames = new Set(installedSkills.map(s => s.name));
      let _fsAdded = 0;
      for (const dirName of _fsDirs) {
        if (!_dbNames.has(dirName)) {
          // Read skill.json for metadata if available
          let _fsMeta = { name: dirName, description: dirName.replace(/_/g, ' '), sourceDomain: null, sourceAction: null };
          const _skillJsonPath = _pathModule.join(SKILLS_BASE, dirName, 'skill.json');
          if (_fsModule.existsSync(_skillJsonPath)) {
            try {
              const _sj = JSON.parse(_fsModule.readFileSync(_skillJsonPath, 'utf8'));
              _fsMeta.sourceDomain = _sj.source_domain || _sj.agent_id?.replace('.agent', '') || null;
              _fsMeta.sourceAction = _sj.source_action || null;
              if (_sj.description) _fsMeta.description = _sj.description;
              _fsMeta.goalTied = _sj.goal_tied || false;
            } catch (_) {}
          }
          installedSkills.push(_fsMeta);
          _fsAdded++;
        }
      }
      if (_fsAdded > 0) {
        logger.debug(`[Node:ParseSkill] Merged ${_fsAdded} filesystem skill dir(s) not in DB into candidate list`);
      }
    } catch (_fsErr) {
      logger.debug(`[Node:ParseSkill] Could not read skills dir for fs merge: ${_fsErr.message}`);
    }
  }

  const msgLower = classifyMessage.toLowerCase();

  for (const skill of installedSkills) {
    const skillName = skill.name; // e.g. "check.weather.daily"
    const skillLower = skillName.toLowerCase();

    // Strategy 1: exact dot-name match — message starts with or contains "check.weather.daily"
    if (
      msgLower === skillLower ||
      msgLower.startsWith(skillLower + ' ') ||
      msgLower.startsWith(skillLower + ':') ||
      msgLower.startsWith('run ' + skillLower) ||
      msgLower.startsWith('use ' + skillLower) ||
      msgLower.startsWith('execute ' + skillLower)
    ) {
      logger.debug(`[Node:ParseSkill] Exact match: "${classifyMessage}" → skill "${skillName}"`);
      return _matchedState(state, skillName);
    }

    // Strategy 2: natural language — dot replaced by spaces
    // "check.weather.daily" → "check weather daily"
    const skillPhrase = skillLower.replace(/\./g, ' ');
    if (msgLower.includes(skillPhrase)) {
      // Confirm word boundaries on each end of the phrase
      const idx = msgLower.indexOf(skillPhrase);
      const before = idx === 0 ? '' : msgLower[idx - 1];
      const after = msgLower[idx + skillPhrase.length] || '';
      const boundaryBefore = before === '' || before === ' ' || before === '\t';
      const boundaryAfter = after === '' || after === ' ' || after === ',' || after === '.' || after === ':';
      if (boundaryBefore && boundaryAfter) {
        logger.debug(`[Node:ParseSkill] Natural-language match: "${classifyMessage}" → skill "${skillName}"`);
        return _matchedState(state, skillName);
      }
    }
  }

  const intentConf = state.intent?.confidence ?? 0;

  // ── Strategy 2.7: description-keyword overlap match ─────────────────────────
  // Deterministic fallback before the LLM: extract meaningful capability words
  // from the user message and check if any installed skill's description contains
  // a critical mass of them. This catches "scroll / type / shortcut / app control"
  // requests matching browser.act without relying on the LLM.
  const userWantsToCreate = WANTS_TO_CREATE_RE.test(classifyMessage);
  {
    // Capability keyword groups — each group is a set of synonyms for one concept.
    // A skill description must contain at least MIN_GROUPS_MATCHED groups to match.
    const CAPABILITY_GROUPS = [
      { words: ['scroll', 'scrolling', 'scroll up', 'scroll down', 'scrolls'] },
      { words: ['type', 'typing', 'type text', 'type chars', 'keypress'] },
      { words: ['keyboard', 'keystroke', 'shortcut', 'shortcuts', 'hotkey', 'key combination', 'ctrl+', 'cmd+', 'command+'] },
      { words: ['click', 'clicking', 'mouse click'] },
      { words: ['mouse', 'cursor', 'move mouse', 'drag', 'right-click', 'double-click', 'mouse button'] },
      { words: ['app control', 'control app', 'interact with app', 'application control', 'desktop automation', 'ui automation', 'automate app'] },
      { words: ['playwright', 'nut-js', 'nut.js', 'robotjs', 'pyautogui', 'xdotool'] },
      { words: ['window', 'windows', 'active window', 'current app'] },
      { words: ['foreground', 'foreground app', 'bring to front', 'bring to foreground', 'focus window', 'focus app', 'activate window'] },
    ];
    const MIN_GROUPS_MATCHED = 2; // user message must hit ≥2 groups to qualify

    const msgWords = msgLower;

    // How many capability groups does the user message touch?
    const userGroupHits = CAPABILITY_GROUPS.filter(g => g.words.some(w => msgWords.includes(w))).length;

    // Gate on command_automate with high confidence — parseIntent already ran upstream; skip for non-execution intents.
    if (state.intent?.type === 'command_automate' && intentConf >= 0.75 && userGroupHits >= MIN_GROUPS_MATCHED) {
      // Now check installed skills — find one whose description also hits ≥2 of the same groups
      for (const skill of installedSkills) {
        const descLower = (skill.description || skill.summary || '').toLowerCase();
        if (!descLower) continue;
        const descGroupHits = CAPABILITY_GROUPS.filter(g => g.words.some(w => descLower.includes(w))).length;
        if (descGroupHits >= MIN_GROUPS_MATCHED) {
          logger.info(`[Node:ParseSkill] Description-keyword match (${userGroupHits}/${descGroupHits} groups): "${classifyMessage.substring(0, 60)}" → skill "${skill.name}"${userWantsToCreate ? ' (userWantsToCreate)' : ''}`);
          return _matchedState(state, skill.name, userWantsToCreate);
        }
      }
    }
  }

  // ── Strategy 2.8: diagnostic/repair intent → prefer debug/repair skills ──────────
  // "why is my calendar broken" must route to oauth.debug, NOT gcal.event.
  // The LLM semantic match (Strategy 3) misroutes these because the service keyword
  // ("calendar") dominates over the diagnostic intent. Catch them deterministically:
  // if the message signals that something is broken/needs fixing, AND an installed
  // skill whose name contains "debug"/"repair"/"diagnose"/"health" has at least one
  // meaningful word in common with the message, prefer that skill.
  {
    const DIAGNOSTIC_INTENT_RE = /\b(why\s+(is|are|isn'?t|aren'?t|won'?t|doesn'?t|can'?t)|broken[\s?!]|(isn'?t|not|won'?t|doesn'?t)\s+work(ing)?|fix\s+(my|this|the)|debug\s+(my|this|the)|diagnose|repair\s+(my|this|the)|what'?s\s+wrong|something'?s\s+(wrong|off|broken)|keep(s)?\s+(failing|breaking|erroring|looping))\b/i;
    const DIAGNOSTIC_NAME_MARKERS = ['debug', 'repair', 'diagnose', 'health'];

    if (DIAGNOSTIC_INTENT_RE.test(classifyMessage) && !userWantsToCreate) {
      const diagSkills = installedSkills.filter(s =>
        DIAGNOSTIC_NAME_MARKERS.some(m => s.name.toLowerCase().includes(m))
      );
      if (diagSkills.length > 0) {
        const msgTokens = new Set(
          classifyMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3)
        );
        const scored = diagSkills.map(s => {
          const descWords = (s.description || s.summary || '').toLowerCase().split(/\W+/);
          const overlap = descWords.filter(w => w.length > 3 && msgTokens.has(w)).length;
          return { skill: s, overlap };
        }).sort((a, b) => b.overlap - a.overlap);

        if (scored[0] && scored[0].overlap >= 1) {
          const best = scored[0].skill;
          logger.info(`[Node:ParseSkill] Diagnostic-intent match: "${classifyMessage.substring(0, 60)}" → skill "${best.name}" (overlap=${scored[0].overlap})`);
          return _matchedState(state, best.name);
        }
      }
    }
  }

  // ── Strategy 5: Domain + source_action match ──────────────────────────────────
  // Matches skills that have source_domain and source_action metadata (set by explore.agent).
  // Detects the target service from the message by checking if any source_domain keyword
  // (e.g. "perplexity", "krea") appears in the message, then scores source_action tokens
  // against the message words.
  // e.g. "goto history on perplexity" → source_domain=perplexity.ai, source_action=history → HIGH match
  {
    // Exclude goal_tied skills — sub-step atomics must not be matched as standalone tasks.
    // They are surfaced internally by browser.agent after it reads the agent context.
    const domainSkills = installedSkills.filter(s => s.sourceDomain && s.sourceAction && !s.goalTied);
    if (domainSkills.length > 0 && !userWantsToCreate) {
      // Build a set of unique domains present in installed skills
      const uniqueDomains = [...new Set(domainSkills.map(s => s.sourceDomain))];
      let detectedDomain = null;
      for (const domain of uniqueDomains) {
        // Extract the base service name from the hostname: "perplexity.ai" → "perplexity"
        const serviceKeyword = domain.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (serviceKeyword.length >= 3 && msgLower.includes(serviceKeyword)) {
          detectedDomain = domain;
          break;
        }
      }

      if (detectedDomain) {
        const candidates = domainSkills.filter(s => s.sourceDomain === detectedDomain);
        // Score each candidate: tokenize source_action and count how many tokens appear in message
        const stopWords = new Set(['the', 'to', 'a', 'an', 'and', 'or', 'on', 'in', 'at', 'for', 'with', 'of']);
        const msgTokens = new Set(msgLower.split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w)));

        let best = null;
        let bestScore = 0;
        for (const skill of candidates) {
          const actionTokens = skill.sourceAction.toLowerCase().split(/[_\s]+/).filter(w => w.length > 2 && !stopWords.has(w));
          if (actionTokens.length === 0) continue;
          const matches = actionTokens.filter(t => msgTokens.has(t)).length;
          const score = matches / actionTokens.length;
          // Prefer skills with parameters when the message has extra context beyond the domain keyword
          const fs = require('fs');
          const os = require('os');
          let skillPath = skill.execPath?.startsWith('~/') ? require('path').join(os.homedir(), skill.execPath.slice(2)) : skill.execPath;
          // Underscore fallback for stale dot-notation exec_path
          if (skillPath && !fs.existsSync(skillPath)) {
            const _d = require('path').basename(require('path').dirname(skillPath));
            const _u = _d.replace(/\./g, '_');
            if (_u !== _d) {
              const _alt = require('path').join(require('path').dirname(require('path').dirname(skillPath)), _u, require('path').basename(skillPath));
              if (fs.existsSync(_alt)) skillPath = _alt;
            }
          }
          let hasParams = false;
          let hasRequiredParams = false;
          let _skillMod = null;
          if (skillPath && fs.existsSync(skillPath)) {
            try {
              delete require.cache[require.resolve(skillPath)];
              _skillMod = require(skillPath);
              const _paramKeys = Object.keys(_skillMod?.parameters || {});
              hasParams = _paramKeys.length > 0;
              hasRequiredParams = _paramKeys.some(k => _skillMod.parameters[k]?.required === true);
            } catch (_) {}
          }
          // Boost score if skill has params and msg has tokens beyond just the domain keyword
          const adjustedScore = score + (hasParams && msgTokens.size > 2 ? 0.1 : 0);
          if (adjustedScore > bestScore) {
            bestScore = adjustedScore;
            best = skill;
            best._hasRequiredParams = hasRequiredParams;
            best._skillMod = _skillMod;
          }
        }

        if (best && bestScore >= 0.3) {
          // ── Required-params guard ─────────────────────────────────────────────
          // If the best match requires parameters (e.g. navigate_history requires
          // `query`), verify the message contains extractable content beyond the
          // bare domain keyword. A sub-prompt like "navigate to my perplexity
          // account" has no search content — matching navigate_history here causes
          // the plan step to fire with no `query` arg and throw immediately.
          // When this guard fires, fall through to LLM planning which will
          // correctly route to browser.agent instead.
          if (best._hasRequiredParams) {
            const _serviceKeyword = detectedDomain.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
            const _actionTokens = new Set(
              (best.sourceAction || '').toLowerCase().split(/[_\s]+/).filter(w => w.length > 2)
            );
            // UI/navigation words that appear in account-navigation sub-prompts but carry
            // no search-query content (e.g. "account", "profile", "page", "login").
            // Excluding them prevents "navigate to my perplexity account" from passing
            // the guard via the bare word "account".
            const _navUiWords = new Set([
              'navigate', 'navigation', 'goto', 'open', 'visit', 'access',
              'account', 'profile', 'page', 'site', 'website',
              'login', 'signin', 'logout', 'signout',
              'click', 'home', 'dashboard', 'menu', 'settings', 'setting',
              'section', 'tab', 'panel', 'link', 'button',
            ]);
            // Tokens that are just the domain keyword, shared action tokens, or generic
            // UI/navigation words carry no extractable search content
            const _contentTokens = [...msgTokens].filter(
              t => t !== _serviceKeyword && !_actionTokens.has(t) && !_navUiWords.has(t)
            );
            if (_contentTokens.length === 0) {
              logger.info(`[Node:ParseSkill] Required-params guard: skipping "${best.name}" — message has no content tokens beyond domain/action keywords (msg: "${classifyMessage.substring(0, 60)}")`);
              // fall through to LLM planning
            } else {
              logger.info(`[Node:ParseSkill] Domain+action match: "${classifyMessage.substring(0, 60)}" → skill "${best.name}" (domain=${detectedDomain}, action=${best.sourceAction}, score=${bestScore.toFixed(2)})`);
              return _matchedState(state, best.name, false, detectedDomain, best.sourceAction);
            }
          } else {
            logger.info(`[Node:ParseSkill] Domain+action match: "${classifyMessage.substring(0, 60)}" → skill "${best.name}" (domain=${detectedDomain}, action=${best.sourceAction}, score=${bestScore.toFixed(2)})`);
            return _matchedState(state, best.name, false, detectedDomain, best.sourceAction);
          }
        } else if (candidates.length > 0 && bestScore === 0) {
          // Domain matched but zero action-token overlap — no evidence to pick any skill.
          // Fall through to Strategy 3 (LLM semantic) or planSkills + browser.agent.
          logger.debug(`[Node:ParseSkill] Domain match (no action overlap): skipping all ${candidates.length} candidate(s) — zero score, falling through to LLM planning (msg: "${classifyMessage.substring(0, 60)}")`);
        }
      }
    }
  }

  // ── Strategy 3: LLM semantic match ──────────────────────────────────────────
  // Only fires when intent is confirmed command_automate with high confidence AND we have an LLM backend.
  // Builds a compact skill menu (name + description) and asks the LLM for a
  // clear match. Falls through gracefully on timeout, missing backend, or null.
  if (state.intent?.type !== 'command_automate' || intentConf < 0.75) {
    logger.debug(`[Node:ParseSkill] Strategy 3 skipped — intent is not command_automate: "${classifyMessage.substring(0, 80)}"`);
    return state;
  }
  if (!llmBackend) {
    logger.debug(`[Node:ParseSkill] No skill match (no llmBackend for semantic fallback): "${classifyMessage.substring(0, 80)}"`);
    return state;
  }

  // ── Guard: skip Strategy 3 when all installed skills are invalid (exec file missing on disk) ──
  // Avoids a ~2-3s LLM round-trip when the only installed skill(s) have a broken
  // exec_path (e.g. oauth.debug with no index.cjs). skill.review flags these at startup.
  {
    const fs = require('fs');
    const os = require('os');
    const executableSkills = installedSkills.filter(s => {
      const execPath = s.execPath || s.exec_path;
      if (!execPath) return false;
      const resolved = execPath.startsWith('~/') ? require('path').join(os.homedir(), execPath.slice(2)) : execPath;
      if (fs.existsSync(resolved)) return true;
      // Underscore fallback: dot-notation dir in DB → underscore dir on disk
      const _dir = require('path').basename(require('path').dirname(resolved));
      const _uDir = _dir.replace(/\./g, '_');
      if (_uDir !== _dir) {
        const alt = require('path').join(require('path').dirname(require('path').dirname(resolved)), _uDir, require('path').basename(resolved));
        return fs.existsSync(alt);
      }
      return false;
    });
    if (executableSkills.length === 0) {
      logger.debug(`[Node:ParseSkill] Strategy 3 skipped — all ${installedSkills.length} skill(s) have invalid exec_path (no runnable skills): "${classifyMessage.substring(0, 80)}"`);
      return state;
    }
  }

  // Only attempt if at least some skills have descriptions — otherwise the LLM
  // has nothing useful to compare against.
  // Exclude goal_tied skills — they are sub-step atomics recorded by explore.agent,
  // intended to be invoked internally by browser.agent, not matched as standalone tasks.
  // Semantic match on these causes a domain fast-path to fire a broken single-step plan
  // instead of delegating the full task to browser.agent.
  let skillsWithDesc = installedSkills.filter(s => (s.description || s.summary) && !s.goalTied);
  if (skillsWithDesc.length === 0) {
    logger.debug(`[Node:ParseSkill] No skill match (no descriptions for semantic match): "${classifyMessage.substring(0, 80)}"`);
    return state;
  }

  // ── Pre-LLM guard: recurring request → exclude one-shot calendar/event skills ──
  // Prevents "cold plunge every morning" from matching gcal.event.
  // Only filters when the message has clear recurring signals AND does NOT
  // explicitly mention Google Calendar or "calendar event".
  const hasRecurringSignal = RECURRING_SIGNALS_RE.test(classifyMessage);
  const hasExplicitCalendar = /\b(google calendar|my calendar|calendar event|add to (my )?calendar|create (a |an )?event|make (a |an )?appointment)\b/i.test(classifyMessage);
  if (hasRecurringSignal && !hasExplicitCalendar) {
    const beforeFilter = skillsWithDesc.length;
    skillsWithDesc = skillsWithDesc.filter(s => {
      const nameLow = s.name.toLowerCase();
      return !ONE_SHOT_EVENT_MARKERS.some(m => nameLow.includes(m));
    });
    if (skillsWithDesc.length < beforeFilter) {
      logger.info(`[Node:ParseSkill] Pre-LLM guard: excluded ${beforeFilter - skillsWithDesc.length} one-shot event skill(s) — recurring request detected ("${classifyMessage.substring(0, 60)}")`);
    }
    if (skillsWithDesc.length === 0) {
      logger.debug(`[Node:ParseSkill] Semantic skipped — all candidates excluded by recurring guard`);
      return state;
    }
  }

  const skillMenu = skillsWithDesc
    .map(s => `- ${s.name}: ${(s.description || s.summary || '').slice(0, 120)}`)
    .join('\n');

  const semanticPrompt = `User request: "${classifyMessage}"\n\nInstalled skills:\n${skillMenu}\n\nDoes any skill clearly match this request? Return "skill-name|HIGH" or "null".
Examples: "gcal.event|HIGH" or "null"`;

  try {
    const raw = await Promise.race([
      llmBackend.generateAnswer(semanticPrompt, {
        systemInstructions: SEMANTIC_SYSTEM_PROMPT,
        conversationHistory: [],
        intent: 'command_automate'
      }, { maxTokens: 60, temperature: 0, fastMode: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('semantic timeout')), 5000)),
    ]);

    // Parse format: "skill-name|HIGH" or legacy plain "skill-name" or "null"
    const rawTrimmed = (raw || '').trim().replace(/^["`']|["`']$/g, '');
    // Split on pipe — if HIGH confidence declared, take it; otherwise plain name treated as HIGH (backwards compat)
    const [candidatePart, confidencePart] = rawTrimmed.split('|').map(p => p.trim().toLowerCase());
    const candidate = candidatePart;
    const confidence = confidencePart || 'high'; // legacy responses without pipe treated as HIGH

    if (confidence !== 'high') {
      logger.debug(`[Node:ParseSkill] Semantic LLM returned confidence "${confidence}" — skipping (only HIGH accepted)`);
    } else if (candidate && candidate !== 'null' && candidate !== 'none' && candidate !== '') {
      // Verify the returned name is actually an ALLOWED candidate (not filtered out by recurring guard)
      let confirmed = skillsWithDesc.find(s => s.name.toLowerCase() === candidate);
      if (!confirmed) {
        // Substring rescue: LLM wrapped the skill name in prose instead of bare format.
        // Scan the entire raw response for any installed skill name appearing verbatim.
        // Prefer the LONGEST matching name — shorter names are often prefixes of more
        // specific ones (e.g. "mail_google_com_settings" ⊂ "mail_google_com_gmail_settings_general_l_...").
        const rawLower = rawTrimmed.toLowerCase();
        
        // Guard 1: Check for explicit rejection patterns (LLM said no match)
        const rejectionPatterns = [
          /\bno\s+match\b/, /\bnone\b/, /\bnull\b/, /\bdoesn'?t\s+match\b/,
          /\bnot\s+(?:a\s+)?match\b/, /\bavailable\s+skills\s+are\b/,
          /\bno\s+skill\s+(?:for|matches)\b/
        ];
        const hasRejection = rejectionPatterns.some(p => p.test(rawLower));
        
        // Guard 2: Check position - skill name should be early or response short
        // Find the earliest skill name match
        const skillPositions = skillsWithDesc.map(s => ({
          skill: s,
          position: rawLower.indexOf(s.name.toLowerCase())
        })).filter(sp => sp.position >= 0);
        
        const earliestSkill = skillPositions.sort((a, b) => a.position - b.position)[0];
        const earliestPosition = earliestSkill ? earliestSkill.position : -1;
        const isEarlyPosition = earliestPosition >= 0 && earliestPosition < 30;
        const isShortResponse = rawTrimmed.length < 80;
        
        // Guard 3: Check for contradiction context before the earliest skill name
        let hasContradiction = false;
        if (earliestPosition > 20) {
          const beforeSkill = rawLower.substring(earliestPosition - 20, earliestPosition);
          hasContradiction = /\b(but|however|instead|rather)\b/.test(beforeSkill);
        }
        
        // Only rescue if all guards pass
        if (!hasRejection && (isEarlyPosition || isShortResponse) && !hasContradiction) {
          const subMatches = skillsWithDesc.filter(s => rawLower.includes(s.name.toLowerCase()));
          confirmed = subMatches.sort((a, b) => b.name.length - a.name.length)[0] || null;
          if (confirmed) {
            logger.info(`[Node:ParseSkill] Semantic LLM substring rescue: extracted "${confirmed.name}" from prose response (${subMatches.length} candidate(s))`);
          }
        } else {
          logger.debug(`[Node:ParseSkill] Substring rescue blocked - hasRejection:${hasRejection}, early:${isEarlyPosition}, short:${isShortResponse}, contradiction:${hasContradiction}, earliestPos:${earliestPosition}`);
        }
      }
      if (confirmed) {
        logger.info(`[Node:ParseSkill] Semantic match: "${classifyMessage.substring(0, 60)}" → skill "${confirmed.name}"${userWantsToCreate ? ' (userWantsToCreate)' : ''}`);
        // Pass sourceDomain/sourceAction so planSkills domain fast-path fires and prepends navigate step
        const _confirmedDomain = confirmed.sourceDomain || null;
        const _confirmedAction = confirmed.sourceAction || null;
        return _matchedState(state, confirmed.name, userWantsToCreate, _confirmedDomain, _confirmedAction);
      } else {
        logger.debug(`[Node:ParseSkill] Semantic LLM returned unknown skill "${candidate}" — ignoring`);
      }
    } else {
      logger.debug(`[Node:ParseSkill] Semantic LLM returned null — no match`);
    }
  } catch (e) {
    logger.debug(`[Node:ParseSkill] Semantic match skipped: ${e.message}`);
  }

  logger.debug(`[Node:ParseSkill] No skill match for: "${classifyMessage.substring(0, 80)}"`);
  return state;
};

function _matchedState(state, skillName, userWantsToCreate = false, matchedSkillDomain = null, matchedSkillAction = null) {
  return {
    ...state,
    matchedSkillName: skillName,
    matchedSkillUserWantsToCreate: userWantsToCreate,
    matchedSkillDomain,
    matchedSkillAction,
    intent: {
      type: 'command_automate',
      confidence: 1.0,
      entities: [{ skill: 'external.skill', name: skillName }],
      requiresMemoryAccess: false
    },
    metadata: { parser: 'parseSkill-exact', processingTimeMs: 0 }
  };
}
