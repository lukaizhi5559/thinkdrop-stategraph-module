/**
 * Synthesize Node — LLM comparison/summary of multi-source browser content
 *
 * Runs as a first-class StateGraph node (not buried in answer.js).
 * Receives synthesisContext + synthesisPrompt from executeCommand's synthesize step.
 * Streams the answer like any other node, writes to synthesisFilePath if set,
 * and returns state with `answer` set so downstream nodes (logConversation,
 * or any future chained task like Gemini) can consume it.
 */

const fs = require('fs');
// Canonical patterns live in shared/text-patterns.cjs — update there, not here.
const { stripUnresolvedTokens } = require('../../../shared/text-patterns.cjs');

// Delivery-bounce detection. When confirming a sent email, the sent thread can
// contain a Mail Delivery Subsystem bounce ("Address not found") — the message
// WAS sent; the bounce only concerns recipient delivery.
//
// Strong markers are mail-specific and sufficient alone. Weak markers
// ("address not found", "couldn't be found") are generic — a store-locator or
// geocoding synthesis can legitimately contain them — so they only count when
// the context is clearly email-related AND the prompt is a send-verification.
const _BOUNCE_STRONG = /mail delivery subsystem|delivery status notification|undeliverable|delivery has failed|message (wasn'?t|was not) delivered|returned to sender/i;
const _BOUNCE_WEAK = /address not found|couldn'?t be found/i;
const _MAIL_CONTEXT = /mail|e-?mail|gmail|recipient|inbox|sent (mail|items|folder)|compose|subject:/i;
const _SEND_VERIFY = /sent|send|deliver|confirm|went through|did it (go|send)/i;

function _hasBounceMarker(synthesisContext, prompt) {
  const ctx = synthesisContext || '';
  if (_BOUNCE_STRONG.test(ctx)) return true;
  return _BOUNCE_WEAK.test(ctx) && _MAIL_CONTEXT.test(ctx) && _SEND_VERIFY.test(prompt || '');
}

module.exports = async function synthesizeNode(state) {
  const {
    logger,
    llmBackend,
    synthesisContext,
    synthesisPrompt,
    synthesisFilePath,
    queryMessage,
    context,
    streamCallback,
    progressCallback,
  } = state;

  logger.debug('[Node:Synthesize] Starting synthesis');

  if (!synthesisContext) {
    logger.warn('[Node:Synthesize] No synthesisContext — nothing to synthesize');
    return { ...state, answer: '[No content collected for synthesis]', needsSynthesis: false };
  }

  if (!llmBackend) {
    logger.error('[Node:Synthesize] No llmBackend available');
    return { ...state, answer: '[Synthesis failed: no LLM backend]', needsSynthesis: false };
  }

  const isStreaming = typeof streamCallback === 'function';

  // Strip unresolved plan-contract tokens from the prompt — a literal
  // "{{LAST_SUCCESSFUL.outputs.filePaths[0]}}" reaching the LLM produces a
  // meta-answer about templates instead of the actual result. (synthesisContext
  // is left alone — fetched page content can legitimately contain {{ }} syntax.)
  const _cleanPrompt = stripUnresolvedTokens;
  const synthesisQuery = `${_cleanPrompt(synthesisPrompt || queryMessage)}\n\nHere is the content collected from each source:\n\n${synthesisContext}`;
  const _todayISO = new Date().toISOString().slice(0, 10);

  // ── Detect system-info shell output for targeted synthesis instructions ──
  // System commands (df, diskutil, sysctl, pmset, system_profiler, sw_vers) produce
  // raw dumps with dozens of fields. The LLM must extract ONLY what the user asked for.
  const _hasSystemInfo = /(?:filesystem|disk size|container total space|container free space|hw\.memsize|hw\.physicalcpu|hw\.logicalcpu|machdep\.cpu|internalbattery|productname:\t\tmacos|buildversion:|model name:|total number of cores|spdisplaysdatatype|sphardwaredatatype|spusbdatatype)/i.test(synthesisContext || '');
  const _isJsonShell = /=== Shell output[^\n]*\n\s*[\[{]/i.test(synthesisContext || '');

  // ── Delivery-bounce detection ────────────────────────────────────────────
  // When confirming a sent email, the sent thread can contain a Mail Delivery
  // Subsystem bounce ("Address not found"). The message WAS sent — the bounce
  // concerns delivery to the recipient address, not the send action. Without
  // this instruction the LLM reports "the email failed to send".
  const _hasBounce = _hasBounceMarker(synthesisContext, synthesisPrompt || queryMessage);
  const _bounceNote = _hasBounce
    ? `\n\nIMPORTANT: The context contains a mail-delivery bounce notification (e.g. "Mail Delivery Subsystem — Address not found"). This means the email WAS sent — the bounce only concerns whether the recipient address could receive it. Report the send as successful, and mention the bounce as a separate delivery caveat (e.g. "sent, but it may not have been delivered — the recipient address bounced").`
    : '';

  const synthesisInstructions = _hasSystemInfo
    ? `You are a concise system-information assistant.
The user asked: "${queryMessage || synthesisPrompt}"

You have been given raw output from macOS system commands (df, diskutil, sysctl, pmset, system_profiler, sw_vers, ps, etc.).

CRITICAL RULES:
1. Answer ONLY the user's specific question. The raw output contains dozens of fields — extract ONLY the ones relevant to what the user asked.
2. Do NOT repeat or quote the raw command output. Do NOT list device identifiers, UUIDs, partition types, file system details, SMART status, APFS snapshots, or other low-level metadata unless the user explicitly asked for them.
3. Present the answer in 1-3 plain, human-readable sentences.
4. Use friendly units: "245 GB total", "17 GB used", "50 GB free", "8 GB RAM", "Apple M1", "83% battery".

EXAMPLES of good answers:
- User asks "get disk storage" → "You have 245 GB of total disk storage, with 17 GB used and 50 GB available."
- User asks "how much memory" → "Your Mac has 8 GB of RAM."
- User asks "what CPU" → "Your Mac has an Apple M1 chip with 8 cores (4 performance + 4 efficiency)."
- User asks "battery level" → "Your battery is at 83% and currently discharging."
- User asks "OS version" → "You're running macOS 15.2 (Build 24C101)."

EXAMPLES of bad answers (DO NOT DO THIS):
- Quoting the full df table
- Listing Volume UUID, Partition Type, SMART Status
- Saying "The disk is an APFS Volume Snapshot with..."
- Including device identifiers like "disk3s1s1"

If the raw output is missing the specific field the user asked about, say so directly.`
    : _isJsonShell
    ? `You are a technical analyst. You have been given data returned by a shell command or API call.\n\nThe user asked: "${queryMessage || synthesisPrompt}"\n\nAnswer their specific question directly and concisely using ONLY the relevant data. Format output in markdown — use bold for names/titles, bullet points for lists, and human-readable dates. Skip internal IDs, raw URLs, and low-level metadata unless the user explicitly asked for them. Do NOT output raw JSON or JSON field names verbatim.`
    : `You are a helpful assistant. Today's date is ${_todayISO}. The user asked you to summarize or analyze data from API responses or web sources. You have been given the content. Provide a clear, concise answer that directly addresses the user's request. When the user's question references a time period (e.g. "last week", "yesterday", "two weeks ago"), reason relative to today (${_todayISO}). Do not assume a date from your training data. Never ask the user for clarification or additional information — you MUST produce the requested content using only the provided context. If details are ambiguous, produce the best-effort response. Do not output a question as your answer. CRITICAL: NEVER say a source "did not provide a response" or "no content was found" when page text is present in the context below. Always extract and summarize what IS there, even if it appears sparse or incomplete.${_bounceNote}`;

  const synthPayload = {
    query: synthesisQuery,
    context: {
      conversationHistory: [],
      systemInstructions: synthesisInstructions,
      sessionId: context?.sessionId,
      userId: context?.userId,
      intent: 'command_automate'
    },
    // File writes need more room — ANY saveToFile (code, docs, markdown alike)
    // must emit the complete content; 1500 tokens truncates mid-file.
    options: { maxTokens: synthesisFilePath ? 4096 : 1500, temperature: 0.2, fastMode: false, taskType: 'complex' }
  };

  try {
    const synthesisAnswer = await llmBackend.generateAnswer(
      synthesisQuery,
      synthPayload,
      synthPayload.options,
      isStreaming ? streamCallback : null
    );

    logger.debug(`[Node:Synthesize] Answer generated (${synthesisAnswer.length} chars)`);

    if (!isStreaming && typeof streamCallback === 'function' && synthesisAnswer) {
      streamCallback(synthesisAnswer);
    }

    // Write to file if requested via synthesize args.saveToFile
    // (shell.run can't do this — it runs before synthesis generates the text)
    if (synthesisFilePath) {
      try {
        fs.writeFileSync(synthesisFilePath, synthesisAnswer, 'utf8');
        logger.debug(`[Node:Synthesize] Saved to: ${synthesisFilePath}`);
      } catch (writeErr) {
        logger.warn(`[Node:Synthesize] Could not write file: ${writeErr.message}`);
      }
    }

    // Emit step_done with the answer as stdout so the UI shows the synthesis output
    if (progressCallback) {
      progressCallback({
        type: 'step_done',
        stepIndex: state.synthesisStepIndex ?? -1,
        totalSteps: state.synthesisTotalSteps ?? 0,
        skill: 'synthesize',
        description: state.synthesisStepDescription || 'Compare results from all sources',
        stdout: synthesisAnswer,
        isSynthesisResult: true
      });
    }

    return {
      ...state,
      answer: synthesisAnswer,
      synthesisAnswer,        // keep for downstream chaining
      needsSynthesis: false,
      commandExecuted: true,  // signal logConversation to proceed
      metadata: {
        ...state.metadata,
        answerSource: llmBackend.getInfo().type,
        llmBackend: llmBackend.getInfo()
      }
    };
  } catch (error) {
    logger.error('[Node:Synthesize] Failed:', error.message);
    return { ...state, answer: `[Synthesis failed: ${error.message}]`, needsSynthesis: false };
  }
};

module.exports._hasBounceMarker = _hasBounceMarker;
