'use strict';

/**
 * classifyTask — LLM-based task classifier
 *
 * Replaces all per-node NLU regex guards (BYPASS_PATTERNS, _BROWSER_SERVICES,
 * _LOCAL_ACTION_VERBS, _BROWSE_VERB_RE, _RECURRING_SIGNALS_RE, etc.) with a
 * single cached LLM call that runs once per turn inside resolveReferencesV2.
 *
 * Result is attached to state._taskClassification and read by all downstream
 * nodes instead of each node running independent regex.
 *
 * Output shape:
 * {
 *   taskType: 'local_file' | 'local_system' | 'app_automation' | 'browser' | 'messaging' | 'scheduling' | 'query' | 'ambiguous',
 *   isFollowUp: boolean,           // message references prior turn ("that folder", "it", "the result")
 *   followUpTarget: string | null, // resolved concrete value from conversation history
 *   needsClarification: boolean,   // true only when a genuinely critical piece is missing
 *   targetService: string | null,  // named external service if present
 *   isRecurring: boolean,          // recurring/scheduled task signal
 *   isBrowseOnly: boolean,         // pure navigation — no messaging/send intent
 *   requiresDOM: boolean,           // browser task needing DOM access (form fill, login, scrape)
 *   isImageAnalysis: boolean,       // task asks to analyze/describe/scan visual content of local image files
 *   isActivityQuery: boolean,       // user asks about recent activity/work/screen time (memory retrieval)
 *   webAccessMode: 'none' | 'download' | 'public_read' | 'interactive',
 *                                   // how the task touches the web: download a file, read public
 *                                   // info, or interact with a session/auth'd service
 *   expectsFileOutput: boolean,     // task creates/writes a file — path is a destination, not a source
 *   mediaListing: 'none' | 'image' | 'video',
 *                                   // user wants a set/list of media results (cards with links),
 *                                   // not to play/open a specific item
 * }
 *
 * Fails open: any error returns a safe default that never blocks execution.
 */

// Canonical patterns live in shared/text-patterns.cjs — update there, not here.
const { CONVERSATION_RECALL_META_RE, BARE_AFFIRM_RE, BARE_DECLINE_RE, FILE_PATH_RE } = require('./textPatterns.cjs');

// ── Deterministic screen-output detection ──────────────────────────────────
// The LLM's isScreenOutput flag is advisory — phrasing is unambiguous enough
// that a regex is more reliable (observed: identical "show on my screen"
// messages classified both true and false on different turns). The detector
// only ever FORCES the flag on; it never clears an LLM true.
const _SCREEN_SHOW_RE = /\b(show|display|put|project|paint|present|pop|throw|bring|make|give)\b[^.!?]*\bon\s+(?:the\s+|my\s+)?screen\b/i;
const _SCREEN_CLEAR_RE = /\b(clear|dismiss|hide|close|wipe|remove|erase)\b[\w\s'!]*\bscreen\b/i;
const _SCREEN_OFF_RE = /\btake\s+(?:that|it|this|them)\s+off\b[^.!?]*\bscreen\b/i;

function detectScreenOutput(userMessage) {
  const m = String(userMessage || '');
  if (_SCREEN_CLEAR_RE.test(m) || _SCREEN_OFF_RE.test(m)) return 'clear';
  if (_SCREEN_SHOW_RE.test(m)) return 'show';
  return null;
}

/** Force screen-output fields when the detector fires but the LLM demurred. */
function _applyScreenDetect(result, userMessage) {
  const action = detectScreenOutput(userMessage);
  if (!action) return result;
  result.isScreenOutput = true;
  if (action === 'clear' || !result.screenOutputAction) result.screenOutputAction = action;
  if (action === 'show' && !result.screenOutputKind) result.screenOutputKind = 'text';
  return result;
}

const CLASSIFY_SYSTEM_PROMPT = `You are a task classifier for a desktop automation assistant.

Given the user's message and recent conversation history, classify the task.

Output ONLY valid JSON with exactly these fields:
{
  "taskType": "local_file" | "local_system" | "app_automation" | "browser" | "messaging" | "scheduling" | "query" | "ambiguous",
  "isFollowUp": true | false,
  "followUpTarget": "<resolved concrete value>" | null,
  "needsClarification": true | false,
  "targetService": "<service name>" | null,
  "isRecurring": true | false,
  "isBrowseOnly": true | false,
  "requiresDOM": true | false,
  "isScreenFollowUp": true | false,
  "needsFreshScreen": true | false,
  "isAppUiInspection": true | false,
  "isSpatialAnalysis": true | false,
  "isImageAnalysis": true | false,
  "isConversationRecall": true | false,
  "isActivityQuery": true | false,
  "isThoughtReply": true | false,
  "webAccessMode": "none" | "download" | "public_read" | "interactive",
  "interactiveActions": ["login", "add_to_cart", ...] | [],
  "expectsFileOutput": true | false,
  "activeDocRef": "file" | "url" | "screen" | null,
  "mediaListing": "none" | "image" | "video",
  "isScreenOutput": true | false,
  "screenOutputAction": "show" | "clear" | null,
  "screenOutputKind": "text" | "emoji" | "image" | "chart" | "effect" | "alert" | "deck" | "scene" | null,
  "screenOutputContent": "<literal content to display>" | null,
  "screenOutputMood": "neutral" | "warm" | "happy" | "sad" | "alert" | "playful" | "calm" | null,
  "screenOutputPayload": { ... } | null,
  "suggestedIntent": "command_automate" | "screen_intelligence" | "web_search" | "memory_store" | "memory_retrieve" | "general_knowledge" | "greeting" | "screen_display" | "multi_step" | null
}

Field rules:
- taskType:
  - "local_file": create, open, rename, move, copy, delete, generate, write, export, convert, compress, find any local file or folder
  - "local_system": interrogate or control the local machine — check uptime, disk space, memory usage, CPU, battery, network interfaces, running processes, kill a process, system stats, hardware info, environment variables, hostname, OS version, run a shell command, check what is installed, list ports, ping a host. Use this whenever the task requires executing a shell command or querying the OS rather than reading/writing a file. ALSO use "local_system" for any imperative action targeting the current screen or active app UI — e.g. highlight elements, capture screenshot, scroll the screen, annotate, show bounding boxes, monitor screen activity, take a screenshot, zoom in. These execute against the running OS/app. ALSO use "local_system" when the active screen is a web browser and the user wants to click, open, or select a visible text element on the current page (e.g. "click the bible study", "open that project", "select the link"). These are in-page UI interactions handled by app.agent using keyboard shortcuts and screen capture, not browser navigation tasks. DO NOT use "local_system" for PASSIVE OBSERVATION — reading, describing, summarizing, or answering a question about content currently visible on screen or on the open page ("what's on my screen", "what does this page say", "explain what I'm looking at") is "query" — the observation is answered via screen_intelligence, not an OS action.
  - "app_automation": the user wants to use a named desktop application's built-in AI assistant or agent to do work inside that app. The phrase "in [app] use the AI" or "use the AI in [app]" or "ask [app] AI to ..." are strong signals. Examples: "In Devin use the AI to add tests to this file", "Ask Claude in Slack to summarize the thread", "Use Cursor's AI to refactor the file". These are handled by app.agent run_agent, which opens the file and uses the app's AI assistant. Use "app_automation" whenever the user explicitly asks to invoke an app's AI assistant, even if the task also mentions a file path.
  - "browser": navigate, search, open a website, go to a URL, look something up online, or interact with a web page via precise DOM access — ONLY for web browser tasks that go beyond the currently visible page. NOT for tasks that inspect, use, or interact with a native desktop app's UI (e.g. Slack, Figma, Zoom, Discord) — those are "local_system" or "app_automation" or "query" even if a service name is mentioned. NOT for clicking a visible text element on the current browser page — those are "local_system". IMPORTANT: "Open [known web service]" (e.g. "Open Spotify and play my playlist", "Open YouTube and search for X", "Open Notion and create a page") is ALWAYS "browser" — the word "open" here means "launch the web service", not "click a visible element on the current page". Known web services include: Spotify, YouTube, Notion, Slack, Discord, Gmail, GitHub, Twitter/X, LinkedIn, Reddit, TikTok, Instagram, Facebook, Perplexity, ChatGPT, Claude, and any other service with a web player or web app. The local_system "click, open, or select a visible text element" rule does NOT apply when "open" is followed by a named web service. NOT "browser" when the user only wants to read, describe, or summarize the CURRENTLY VISIBLE page ("what does this page say", "read this article on screen", "sum up what's showing") — that is passive observation → "query" (handled by screen_intelligence; no navigation needed).
  - "messaging": send email, text, SMS, Slack, Discord, notify someone
  - "scheduling": set a reminder, schedule something, recurring alarm, cron task
  - "query": question, lookup, retrieve memory, general knowledge — includes asking about or locating UI elements in a desktop app ("show me where X is in Slack", "where is the toolbar in Figma"). Use for tasks that ask to find, describe, or explain something without sending or modifying anything. ALSO "query" for PASSIVE SCREEN OBSERVATION — reading, describing, summarizing, or answering about content currently visible on screen or the open page ("what's on my screen", "describe this page", "explain what's showing", "tell me what this says"). These route to screen_intelligence (capture + answer), not automation. NOT "query" when the task is an imperative action ON the screen (highlight, scroll, capture, monitor, annotate, click, type) — those are "local_system". NOT "query" when the task explicitly asks to use an app's AI assistant — those are "app_automation".
  - "ambiguous": genuinely unclear even with history

- isFollowUp: true when the message refers to something established in RECENT CONVERSATION via any of these signal CATEGORIES (examples are illustrative, not exhaustive):
  1. Pronouns & demonstratives: it, this, that, these, those, they, them, one, same, such, the former, the latter, there, here
  2. Definite-article references to prior context: "the file", "the folder", "the result", "the script", "the code", "the project", "the email", "the document", "the previous [X]", "the above", "that [X]" (e.g. "that folder", "that python", "that directory")
  3. Temporal/additive continuation signals: "now [action]" (e.g. "now email that"), "also", "as well", "too", "what about [X]", "how about [X]"
  4. Clarification/confirmation questions about the assistant's prior claims or an established topic: "are you referring to X", "do you mean X", "did you mean X", "when you say X", "are you talking about X", "is that what you mean", "are you asking about X", "you mean X?" — these continue the prior topic even though they name a concrete noun (e.g. "models") instead of using a pronoun.
  If the message uses ANY word/phrase that refers back to something established in RECENT CONVERSATION, set isFollowUp:true — even if the specific word is not listed above.
  - META-QUESTION EXCEPTION: Set isFollowUp to FALSE when the user is asking ABOUT THE CONVERSATION ITSELF — i.e., meta-questions that request the assistant to inspect, recall, or summarize prior turns of the chat transcript. Signals: "what did I (just) ask", "what did I say", "what did we talk about", "what was my last question", "what did you just say", "what did I ask you (two messages ago / earlier / before)", "summarize our conversation", "what have we been discussing", "repeat what I said". These are NOT topic continuations — they are requests to read the transcript. Do NOT resolve a followUpTarget for these.
  - EPISODIC-QUERY EXCEPTION: "what about [time period]" continuing an activity or work question ("what about this week", "what about today", "and yesterday?") is a NEW episodic query — isFollowUp:false, isActivityQuery:true — not a topic continuation.

- followUpTarget: if isFollowUp is true AND recent conversation clearly shows what it refers to, provide the resolved concrete subject. This includes: a file path from a prior command, a topic/subject discussed (e.g. "Vietnam weather", "the Python script", "SpaceX stock"), a named entity, or any other concrete referent established in the conversation. Set to null only when the referent genuinely cannot be determined from history.
  - OFFER-CONSENT RULE: when the message is a bare affirmation/consent ("yes", "yeah", "yep", "sure", "ok", "okay", "yes you can", "go ahead", "do it", "please do", "sounds good", "absolutely", "of course") replying to the assistant's immediately-preceding offer or yes/no question ("Would you like me to X?", "Want me to X?", "Should I X?", "I can X if you'd like"), the user is ACCEPTING that offer — this is a follow-up, not a new topic. Set isFollowUp:true, needsClarification:false, taskType to whatever the offered action implies, and resolve followUpTarget to the COMPLETE implied task — combine the offered action with the subject it refers to (e.g. assistant offered "search for specific styles, brands, or retailers" about baby clothes → followUpTarget="baby clothes"). The target must stand alone so downstream search/action steps can use it without re-reading history.
  - OFFER-DECLINE RULE: a bare refusal ("no", "nah", "don't", "not now", "no thanks") replying to an assistant offer declines it — set isFollowUp:true, followUpTarget:null, needsClarification:false, taskType:"ambiguous". The answer should acknowledge the decline; do NOT execute the offered action.
  - PROACTIVE-CARD RULE: a proactive card is a popup offer/question the user SAW on screen — "not a spoken reply" only describes HOW it was delivered, not whether it can be answered. A card IS an open offer awaiting a response and fully counts for OFFER-CONSENT/OFFER-DECLINE. Decide in this order:
    1. ATTACHED CARD FIRST: a turn labeled "ATTACHED to the user's reply" is the card that was on screen when the user hit send — privileged evidence. Bare affirmatives/negatives with no topical signal ("yes", "sure", "no thanks", "ok") ARE replies to it → isThoughtReply:true. For an affirmative, also set isFollowUp:true + followUpTarget = the card's implied task (combine the offered action with its subject, same as OFFER-CONSENT). For a refusal, isFollowUp:false + followUpTarget:null (OFFER-DECLINE).
    2. TOPICAL REPLY: if the reply's subject clearly matches an earlier real turn (e.g. "find Roses not all Flowers" after a flower search while the attached card was about a code scan), use THAT turn → isFollowUp:true → that turn's subject, isThoughtReply:false.
    3. Older non-attached cards ("shown to user earlier") may still be the referent of a delayed reply ("that scan you mentioned", "about that meeting") → isThoughtReply:true when the reply explicitly targets a card's topic.
    4. If the reply could plausibly target the attached card OR another turn and the card is not clearly topically excluded → needsClarification:true.
  - ELLIPTICAL-IMPERATIVE RULE: a short imperative that names an ACTION but omits or generic-izes the SUBJECT ("search for me", "do it", "how many unread", "check again", "show me", "pull it up") continues the newest prior turn — isFollowUp:true, followUpTarget = that turn's concrete subject. Do NOT take the message literally (e.g. "search for me" after a mechanics question means search for mechanics, not a literal search for "me").

- expectsFileOutput: true when the task creates/writes/saves/exports a file — the referenced path is a DESTINATION (it may not exist yet), not a source to read. Signals: "save this to X.md", "write the code to ~/Desktop/three.md", "export the results as report.csv", "put that in a file". false for tasks that only read/open/list files, or when no file output is produced.
  - CRITICAL: Set followUpTarget to null when isFollowUp is false (including the META-QUESTION EXCEPTION above). A non-null followUpTarget with isFollowUp=false is invalid.
  - Never set followUpTarget to the user's own prior message text when the user is asking ABOUT that message (e.g., "what did I just ask" → followUpTarget must be null, NOT "what did I just ask").
  - RECENCY PREFERENCE: when resolving followUpTarget, prefer the referent established in the NEWEST conversation messages (the immediately preceding turn) over older RELEVANT EARLIER MESSAGES matches — the prior turn is almost always the intended antecedent for a short elliptical follow-up.
  - ACTIVE DOC CONTEXT (activeDocRef): When an "ACTIVE APP CONTEXT (live):" or "PRIOR SCREEN CONTEXT" block is present AND the user message refers to the currently open document/page/site — e.g. "this file", "this page", "this document", "this site", "the current doc", or a bare "this"/"it" paired with a document action (read, explain, summarize, print, save, edit, download, translate, describe, "tell me about", "what's this about") where CONVERSATION HISTORY does not supply a competing referent — set:
    * "file"   — when the block has a File: path and the referent is that document
    * "url"    — when the block has a URL: (or app is a browser) and the referent is that page/site
    * "screen" — when the referent is visible screen content with no resolvable file/url ("what's on my screen", "this error dialog", "this window")
    * null     — otherwise
  - CRITICAL: NEVER set activeDocRef when the deictic refers to something established in CONVERSATION HISTORY — conversational referents go in followUpTarget with isFollowUp:true. Example: "email me those addresses" after listing addresses → followUpTarget="the addresses", activeDocRef=null even if a file is open. The live doc is the referent ONLY when the message targets a document/page/file/site artifact itself — not a conversational subject (a topic, a result, a list, an answer).
  - activeDocRef and followUpTarget are independent fields — do NOT put the live file path or url into followUpTarget; the resolved value is attached downstream from the context block (activeDocRef only names the KIND of referent).
  - Do NOT resolve activeDocRef to a file mentioned in conversation history — it is ONLY for the live open document/page in the context blocks.
  - LIVE-ARTIFACT NOUN OVERRIDE: explicit nouns that can only exist on screen — "this site", "this webpage", "this website", "this tab", "the browser page", "the browser tab", "the page in the browser", "the page I'm on", "the site I'm on" — resolve to activeDocRef even when CONVERSATION HISTORY supplies a competing referent (e.g. "print this site" after discussing a saved file → activeDocRef="url", followUpTarget may still carry the file). A site/webpage/tab/browser-page referent is never a conversation artifact. Bare "this"/"it" and conversation-artifact nouns ("this file", "the document") still defer to a competing conversation referent.
  - When activeDocRef is "file" or "url", also set isScreenFollowUp:false and needsFreshScreen:false (the target is known — no screen OCR needed). When activeDocRef is "screen", set isScreenFollowUp:true.

- isScreenOutput: true when the user wants content PAINTED ONTO THE SCREEN itself — the GhostLayer visual output surface (a transparent always-on-top layer over the whole desktop). This is WRITING to the screen, the opposite of reading it. Signals: "show it on the screen", "display that on my screen", "put this on screen", "show on screen", "make it rain (on my screen)", "fireworks on the screen", "show a big emoji", "put up a chart on screen", "clear the screen", "take that off the screen".
  - action "show": render/display/paint/put something onto the screen — "show it on the screen", "display John 3:16 on screen", "make it rain", "put up fireworks"
  - action "clear": remove screen displays — "clear the screen", "hide that overlay", "take it off my screen", "dismiss that"
  - screenOutputKind: the requested visual form when identifiable — "make it rain"/"fireworks"/"snow" → "effect"; "big emoji"/"show a smiley" → "emoji"; "pie chart"/"bar chart"/"graph" → "chart"; "show this image/picture on screen" → "image"; "slides/presentation" → "deck"; a full-screen warning/block → "alert"; otherwise "text".
  - screenOutputContent: the literal text/emoji/content to display when embedded in the message ("show 'hello world' on the screen" → "hello world", "display a 🔥 emoji" → "🔥"). null when the referent is a prior assistant answer ("show it on the screen" → null — the node resolves it from history).
  - screenOutputMood: emotional tone when implied — playful/happy/calm/etc., else null.
  - screenOutputPayload: optional structured data for non-text kinds. For "chart" emit {"chart":{"type":"pie|donut|bar|line|area|stat","data":[{"label":..,"value":..}],"xKey":"label","yKey":"value"}} when the message carries the data inline ("pie chart: apples 5, bananas 3"); for "deck" emit {"deck":{"slides":[{"title":..,"bullets":[..]}]}}; for "alert" emit {"severity":"info|warn|block","title":..}. null for text/emoji/effect/image or when data comes from a prior step.
  - When the content to render is data ON THE SCREEN ("chart the data on this page", "graph this table on my screen", "make a chart of what's showing"), also set activeDocRef:"screen" + isScreenFollowUp:true — the data source is the visible screen and downstream needs that hint to capture/read it. Literal content, effects, and scenes get neither flag.
  - BOUNDARY — isScreenOutput is FALSE for: reading/observing the screen ("what's on my screen" → query/isScreenFollowUp), highlighting or annotating app UI elements ("highlight the submit button" → local_system), taking screenshots, and media searches without a screen qualifier ("show me a picture of X" → mediaListing). The screen qualifier must be explicit: "on the screen", "on my screen", "onto the screen", "on screen".

- needsClarification: true ONLY when a truly critical piece is missing AND conversation history does NOT resolve it:
  - WHO to send to (messaging tasks with no recipient anywhere)
  - WHICH service (when multiple equally valid options exist and user gave no hint)
  - For scheduling tasks (reminders, alarms, cron, recurring): set needsClarification:true when the user did NOT specify how they want to be notified/delivered. Notification methods include: macOS notification, ThinkDrop in-app alert, email, text message, write to file. If the user said "email me", "text me", "notify me", "show an alert", "send a notification", "osascript notification", etc. → needsClarification:false (method is specified). If they only said "remind me to X" or "set a reminder for X" with no delivery method → needsClarification:true.
  - Missing or ambiguous file/folder path for app_automation or local_file tasks that the system cannot resolve automatically:
    * A bare basename with NO extension and NO path separator (e.g. "UnifiedOverlay", "the readme", "the config file") → needsClarification:true
    * A filename WITH an extension (e.g. "instruction.runner.cjs", "main.py", "README.md") → needsClarification:false (system can search the project tree)
    * An absolute or relative path that exists → needsClarification:false
  - NEVER ask about file format, content, or preferences — the system can infer those
  - NEVER ask when taskType is local_system or browser — these are always clear enough
  - NEVER ask when isFollowUp is true and followUpTarget is resolved — EXCEPT for scheduling tasks where the notification/delivery method is missing (followUpTarget is the task content, not the delivery method)

- targetService: the specific external service named (e.g. "gmail", "github", "youtube"). null for local tasks. CRITICAL: set targetService ONLY when the user EXPLICITLY names the service in the message — never infer or invent one. "pull up John 3:16" names NO service → null (do not output "biblegateway"). "find videos about X" names no service → null. A service the user didn't type is always wrong.

- isRecurring: true for "every day", "daily", "weekly", "remind me every", "alarm", "recurring", "each morning"

- isBrowseOnly: true when taskType is "browser" AND there is no send/message/notify intent

- isAppUiInspection: true when taskType is "query" AND the task is specifically asking to locate, find, show, or identify a UI element WITHIN a named desktop app (e.g. "show me where the message input area is in Slack", "where is the toolbar in Figma", "find the send button in Discord", "locate the settings panel in Notion", "point me to the search bar in Slack"). These require app.agent to capture and analyze that specific app's screen. false for all other cases, including passive screen observations ("what's on my screen") and general knowledge questions.

- isSpatialAnalysis: true when the task is asking to identify, analyze, map, or describe the SPATIAL LAYOUT, REGIONS, or SECTIONS of the screen — such as headers, sidebars, footers, content areas, grid layout, bounding boxes, or UI zones. These require app.agent analyze_spatial_grid to return structured coordinate data, NOT plain OCR. Examples: "what regions are on my screen" → true | "what sections can you see" → true | "describe the screen layout" → true | "what areas are visible" → true | "show me the screen grid" → true | "what UI zones are present" → true. DISTINCTION: "what is ON my screen" (passive read of content) → false. "what REGIONS/SECTIONS/LAYOUT structure does my screen have" (spatial tool call) → true. false for all passive screen observation queries ("what app am I in", "what's on my screen", "read what's visible").

- isImageAnalysis: true when the task asks to analyze, describe, scan, examine, or understand the VISUAL CONTENT of local image files (png, jpg, jpeg, webp, gif, bmp, tiff, heic, screenshots, photos, pictures). This includes phrases like "what's in these images", "scan the screenshots", "describe the photos", "analyze the images in this folder", "tell me what these files are about" (when the folder contains images). ALSO true when the user references a folder whose name clearly indicates images (e.g. "screenshots", "photos", "images") AND asks to analyze/describe/scan/examine its contents — even if they say "files" instead of "images". false for: listing files, copying/moving/deleting images, converting image formats, resizing/cropping, or any task that doesn't require understanding what the images SHOW. false for live screen capture ("what's on my screen") — that's screen.capture, not image.analyze.

- isConversationRecall: true when the user is asking ABOUT THE CONVERSATION ITSELF — i.e., meta-questions that request the assistant to inspect, recall, summarize, or repeat prior turns of the chat transcript. Signals: "what did I (just) ask", "what did I say", "what did we talk about", "what was my last question", "what did you just say", "what did I ask you (two messages ago / earlier / before / three prompts ago)", "summarize our conversation", "what have we been discussing", "repeat what I said", "remind me what we were talking about", "go back to what I said earlier". These are requests to READ the transcript, NOT topic continuations. When true, isFollowUp MUST be false and followUpTarget MUST be null. IMPORTANT: isConversationRecall is FALSE for queries about the user's PAST ACTIVITY or EPISODIC MEMORY — those are about screen captures and stored facts, NOT chat prompts. Examples where isConversationRecall is FALSE: "do you have any memories from yesterday", "what did I do yesterday", "what was I doing", "what did I watch", "what did I listen to", "what did I buy", "what did I have open", "what was on my screen", "what was I working on". These should be treated as normal memory_retrieve queries.

- webAccessMode: how the task needs to touch the web — pick the CHEAPEST mode that can complete it:
  - "download": the user wants a remote file/asset saved locally (mp3, wav, pdf, image, zip, csv, video, font, etc.) — either from a public URL they gave or found via search. No login, no account, no page interaction. These are handled by web search + curl, NOT by a browser session.
  - "public_read": the user wants to look up, find, search, read, compare, or check PUBLIC information on the web — including "go to <site> and look up X", "find X on <site>", "search <site> for Y", "any new X out recently", "look online for X". The answer comes from search results or public page text; no login, no clicking through site UI, no form submission.
  - "interactive": the task requires a real browser session — login/OAuth/account state, sending/posting/messaging, form fill, add-to-cart/checkout, account settings, filter/picker UIs, media playback controls, multi-step page flows, or the user explicitly wants to browse the site themselves ("open X for me", "show me the site"). Also use "interactive" whenever requiresDOM is true, and as the DEFAULT when taskType is "browser" but the needed access is unclear.
  - "none": the task does not touch the web (local file/system/app tasks, memory, scheduling, pure knowledge queries).
  Key distinction — NAMING a site is NOT enough for "interactive": "download a bird sound from freemusicarchive.org" is "download" (public file), "look up cheap X on amazon" is "public_read" (research), but "add X to my amazon cart" is "interactive" (account action). Download/public_read tasks NEVER need a service agent or auth — they use generic web-search/curl/crawl skills.
  Examples: "Go to eBay and search for 'vintage children's Bible'" → public_read (simple search), "Search Amazon for cheap exercise equipment" → public_read (research), "Add the Bible to my eBay cart" → interactive (account action), "Send an email via Gmail" → interactive (send).
  Image/listing requests are ALWAYS public_read: "show pics of X on [site]", "show me pictures of X for sale on [site]", "find images of X on [site]", "show X listings on [site]" → public_read. The user wants to SEE product images/listings, not interact with the site. "for sale" / "on sale" / "cheap" / "deals" in these prompts are product DESCRIPTORS, not filter requests.
  Example: "show pics of baby clothes for sale on amazon" → public_read (research — user wants to see product images, "for sale" describes the products, not a filter action).

- interactiveActions: list the specific interactive actions this prompt requires, or [] if none. Valid actions: login, oauth, add_to_cart, checkout, place_order, send_message, send_email, post, comment, like, share, follow, subscribe, retweet, react, vote, play_media, pause_media, skip_media, shuffle, repeat, fill_form, submit_form, upload, publish, delete, edit, create, update, deploy, merge_pr, approve_pr, assign_task, settings_change, filter_ui, sort_ui, date_picker, book_reservation. Set to [] when the task is simple search, browse, read, download, or lookup — those are NOT interactive actions. When webAccessMode is "interactive", this array MUST be non-empty (list the actions that make it interactive). When webAccessMode is "public_read", "download", or "none", this MUST be [].
  IMPORTANT: "for sale" / "on sale" / "cheap" / "deals" / "discount" are product DESCRIPTORS, not filter actions. Do NOT set filter_ui for these. filter_ui requires an EXPLICIT filter/refine request like "filter by price under $50", "sort by rating", "only show prime eligible", "narrow down to size medium". A prompt like "show pics of baby clothes for sale on amazon" has NO interactive actions — set interactiveActions to [].
  IMPORTANT: "click the first result", "open the first product", "follow the first link", "select the first item", or similar phrasing is URL SELECTION for reading/extraction — NOT an interactive DOM action. When the overall goal is to search a site and then read/extract the first result, keep webAccessMode="public_read", requiresDOM=false, and interactiveActions=[]. Only mark it interactive if the user also wants to add-to-cart, checkout, filter, fill a form, or otherwise mutate state on that page.

- mediaListing: the user wants a SET/LIST of media results returned (cards with links), not to play, watch, open, or interact with one specific item:
  - "video": find/list/show/pull/recommend videos, tutorials, episodes, sermons, or clips — e.g. "find videos from mike winger on Christ in the old testament", "list of mike winger videos", "show me sourdough tutorial videos", "get me some videos about X". ALSO true for follow-ups whose resolved referent is a video list (e.g. "pull list with links", "I need the links for these" after a video-listing turn).
  - "image": show/find/get pictures, photos, pics, images, or artwork of X — e.g. "show me a picture of X", "find pics of baby clothes", "what does X look like".
  - "none": everything else — including playing/watching/opening a SPECIFIC video ("watch the mike winger video", "play this on youtube"), downloading a media file (that's webAccessMode="download"), and all non-media tasks.
  mediaListing is independent of targetService: "show pics of baby clothes on amazon" is still "image" (the named site is handled downstream).

- isActivityQuery: true when the user asks about their RECENT ACTIVITY, WORK, SCREEN TIME, or CONTENT CONSUMPTION — i.e., queries that should be answered from episodic memory / screen captures / app usage, NOT from the chat transcript and NOT from personal profile data. Signals: "what have I been working on", "what was I working on today", "what did I do yesterday", "what did I watch", "what did I listen to", "what apps did I use", "what was on my screen", "what was I doing", "what have I been up to". When true, the memory retrieval node should use a broad activity query (NOT the raw prompt) and a low similarity threshold, and the answer node should focus on activity/screen/app memories — NOT surface personal profile data (email, phone, address) unless explicitly asked. false for: personal profile queries ("what is my email", "what is my name"), conversation-recall meta-questions (those are isConversationRecall), and non-memory tasks (web search, automation).

- requiresDOM: true when taskType is "browser" AND the task requires precise DOM-level interaction that keyboard shortcuts cannot do reliably. The following categories ALWAYS require DOM:
  1. Content creation and editing: make/create/build/edit/update/modify a playlist, document, board, post, event, collection, album, note, page, wiki article — clicking create/edit buttons, typing names, modifying content, adding items.
  2. Media playback control: play/pause/skip/next/previous/shuffle/repeat on web players (Spotify, YouTube, SoundCloud, Apple Music) — clicking play controls, selecting tracks.
  3. Social media interactions: like, share, comment, follow, retweet, react, vote, subscribe, rate — clicking specific post-level buttons.
  4. E-commerce and booking: add to cart, select size/color/variant, checkout, apply coupon, place order, book flights/hotels/tables/appointments/tickets — navigating product/booking pages, selecting dates/times, filling forms, payment.
  5. Account settings: change password, update profile, toggle settings, enable/disable features, manage integrations/connections — navigating settings pages and filling forms.
  6. Web messaging and email management: send a message on Slack/Discord/Gmail web, archive/label/organize emails, mark as read, create filters, move to folders — clicking channels/threads, typing in message input, interacting with email list controls.
  7. Search with filters/refinement: advanced search using filter UIs, dropdowns, date pickers, price ranges, checkboxes (e.g. "filter flights with 1 stop under $500", "filter products by price and color") — NOT simple search. Simple search ("search X for Y", "look up X on Y", "find X on Y", "go to X and search for Y") is NOT DOM-requiring — typing a query and reading results is achievable via web.crawl or web.agent. Product descriptors like "for sale", "on sale", "cheap", "deals", "discount" are NOT filter requests — "show pics of baby clothes for sale on amazon" does NOT require DOM (use web.crawl/web.agent instead).
  8. File management on web drives: upload/download/organize/rename/move/delete/share files on Google Drive, Dropbox, iCloud, OneDrive web — interacting with file list UIs, context menus, share dialogs.
  9. Project management and code review: move cards/tasks between columns, assign tasks, set due dates, add comments to cards on Trello/Asana/Jira/Monday, review/approve/merge PRs, close/reopen issues, assign labels on GitHub/GitLab — interacting with board UIs, PR review interfaces.
  10. Publishing and scheduling: publish/unpublish/schedule blog posts, tweets, social media content, landing pages — clicking publish/schedule buttons, setting publication dates/times.
  ALSO true for: form fill, login/authentication/OAuth, structured data scraping, file upload via browser input, clicking specific page elements by selector on a page that is NOT currently the visible active screen, multi-step page flows (e.g. click button → wait → fill → submit).
  false for: navigate to URL, open new tab, scroll page, copy page content, find on page, back/forward, reload, or clicking a visible text element on the current browser page — all achievable via keyboard shortcuts or app.agent.
  NEVER true for tasks that ask to visually locate, identify, or describe a UI element in a desktop app (e.g. "show me where the input area is in Slack", "find the toolbar in Figma") — those use screen capture/OCR, not DOM access. Always false when taskType is not "browser".
  NEVER true when the PRIMARY action is a GhostLayer screen highlight (e.g. "highlight [term]", "highlight all text", "show boundaries", "clear highlights", "highlight the term X and type Y") — these are handled entirely by app.agent using LiteParser + nutJS, not DOM access. Secondary words like "type", "input field", or "click" do not change this when highlighting is the leading intent.
  NEVER true when the active screen is a browser and the user wants to click/open/select a visible text element on the current page — those are local_system tasks handled by app.agent.

- isScreenFollowUp: true when ALL of the following hold:
  1. A PRIOR SCREEN CONTEXT block is present in the prompt (see below)
  2. The user message refers to something on screen using a deictic ("this", "it", "that") OR asks for info/explanation without naming a new specific topic
  3. The message does NOT start a clearly unrelated new topic (e.g. "search for X", "open Y", "remind me to Z")
  4. The RECENT CONVERSATION does NOT contain a clear named topic that the message is more likely referring to (e.g. a country, city, person, product, service, website). If conversation history has an established subject and the message is a short follow-up ("check for me now", "what about that?", "do it"), set isScreenFollowUp:false — the follow-up is to the conversation, not the screen.
     CRITICAL BOUNDARY: questions about the ASSISTANT'S PRIOR STATEMENT are always conversation follow-ups, even when that statement described screen content — "are you referring to X", "do you mean X", "when you say X", "still talking about X?" → isScreenFollowUp:false. Content the assistant already summarized lives in the conversation; the user is querying the claim, not the pixels. isScreenFollowUp:true is for screen content the assistant has NOT yet addressed — a visible error, an unremarked dialog, "what does this error mean".
  Set false when no PRIOR SCREEN CONTEXT is present.

- needsFreshScreen: true when ALL of the following hold:
  1. isScreenFollowUp is false (no prior context block available)
  2. followUpTarget is null (referent NOT resolved from conversation history)
  3. isFollowUp is true (message uses deictic terms or refers to something from context without naming it) OR taskType is "ambiguous"
  This means: the user is referring to something they see on screen, but we have no cached screen data — we need to grab it.
  Set false when isScreenFollowUp is already true (we already have context), or when followUpTarget is already resolved from conversation history, or when the message has a concrete named subject.

EXAMPLES (meta-questions — isFollowUp MUST be false, followUpTarget MUST be null, isConversationRecall MUST be true):
  User: "what did I just ask you two messages ago" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":true}
  User: "what have we been talking about" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":true}
  User: "what did I say earlier" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":true}
  User: "summarize our conversation" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":true}
  User: "what did I just ask you three prompts ago" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":true}
  User: "remind me what we were just talking about" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":true}

EXAMPLES (webAccessMode — one per decision boundary):
  User: "find a short bird chirp mp3 and save it to my desktop" → {"taskType":"browser","webAccessMode":"download"}
  User: "download a bird sound from freemusicarchive.org" → {"taskType":"browser","targetService":"freemusicarchive","webAccessMode":"download"}
  User: "goto amazon and look up cheap exercise equipment" → {"taskType":"browser","targetService":"amazon","webAccessMode":"public_read"}
  User: "show pics of baby clothes for sale on amazon" → {"taskType":"browser","targetService":"amazon","isBrowseOnly":true,"requiresDOM":false,"webAccessMode":"public_read","interactiveActions":[]}
  User: "add baby clothes to my amazon cart" → {"taskType":"browser","targetService":"amazon","requiresDOM":true,"webAccessMode":"interactive","interactiveActions":["add_to_cart"]}
  User: "filter amazon results by price under $50" → {"taskType":"browser","targetService":"amazon","requiresDOM":true,"webAccessMode":"interactive","interactiveActions":["filter_ui"]}
  User: "Open Etsy and search for 'wooden cross wall art' then click the first result" → {"taskType":"browser","targetService":"etsy","requiresDOM":false,"webAccessMode":"public_read","interactiveActions":[]}
  User: "look online for other pizzas that are good" → {"taskType":"browser","webAccessMode":"public_read"}
  User: "what's the latest on the spacex launch" → {"taskType":"query","webAccessMode":"public_read"}
  User: "read this article https://example.com/post" → {"taskType":"browser","webAccessMode":"public_read"}
  User: "send an email via gmail" → {"taskType":"messaging","targetService":"gmail","webAccessMode":"interactive"}
  User: "create a notion todo for tomorrow" → {"taskType":"browser","targetService":"notion","requiresDOM":true,"webAccessMode":"interactive"}
  User: "go to chatgpt and ask it about vegan food" → {"taskType":"browser","targetService":"chatgpt","webAccessMode":"interactive"}
  User: "post on twitter" → {"taskType":"browser","targetService":"twitter","requiresDOM":true,"webAccessMode":"interactive"}
  User: "what time is it" → {"taskType":"query","webAccessMode":"none"}  // temporal questions are answered from injected CURRENT LOCAL TIME, not shell automation
  User: "what day is today" → {"taskType":"query","webAccessMode":"none"}
  User: "what's the date" → {"taskType":"query","webAccessMode":"none"}
  User: "check my disk space" → {"taskType":"local_system","webAccessMode":"none"}
  User: "how much memory is this process using" → {"taskType":"local_system","webAccessMode":"none"}

EXAMPLES (mediaListing — list of media results vs. playing one item):
  User: "find videos from mike winger Christ in the old testament" → {"taskType":"browser","targetService":"youtube","webAccessMode":"public_read","mediaListing":"video"}
  User: "list of mike winger videos" → {"taskType":"browser","targetService":"youtube","webAccessMode":"public_read","mediaListing":"video"}
  User: "pull list with links" (after a video-listing turn) → {"taskType":"browser","isFollowUp":true,"followUpTarget":"Mike Winger videos","webAccessMode":"public_read","mediaListing":"video"}
  User: "watch the latest mike winger video on youtube" → {"taskType":"browser","targetService":"youtube","webAccessMode":"interactive","interactiveActions":["play_media"],"mediaListing":"none"}
  User: "show me a picture of a red panda" → {"taskType":"query","webAccessMode":"public_read","mediaListing":"image"}
  User: "show pics of baby clothes for sale on amazon" → {"taskType":"browser","targetService":"amazon","webAccessMode":"public_read","mediaListing":"image"}
  User: "find a bird chirp mp3 and save it" → {"taskType":"browser","webAccessMode":"download","mediaListing":"none"}

EXAMPLES (episodic memory queries — isConversationRecall MUST be false, these are NOT about the chat transcript):
  User: "do you have any memories from yesterday" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":false}
  User: "what did I do yesterday" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":false}
  User: "what about this week" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":false}
  User: "what was I doing earlier" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":false}
  User: "what did I watch yesterday" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isConversationRecall":false}

EXAMPLES (genuine follow-ups — isFollowUp true, followUpTarget resolved):
  User: "what about that" (after discussing Vietnam weather) → {"taskType":"query","isFollowUp":true,"followUpTarget":"Vietnam weather"}
  User: "email it to me" (after retrieving family info) → {"taskType":"messaging","isFollowUp":true,"followUpTarget":"family info"}
  User: "open that folder" (after listing ~/Downloads) → {"taskType":"local_file","isFollowUp":true,"followUpTarget":"~/Downloads"}
  User: "what are they about" (after retrieving memories) → {"taskType":"query","isFollowUp":true,"followUpTarget":"retrieved memories"}
  User: "now email that to me" (after retrieving info) → {"taskType":"messaging","isFollowUp":true,"followUpTarget":"retrieved info"}
  User: "I need the links for these as well" (after listing videos) → {"taskType":"query","isFollowUp":true,"followUpTarget":"video links"}
  User: "are you referring to the models still" (after a screen answer comparing AI models and a short exchange about them) → {"taskType":"query","isFollowUp":true,"followUpTarget":"the AI model comparison","isScreenFollowUp":false}
  User: "what does this error mean" (screen shows an npm error not yet discussed) → {"taskType":"query","isScreenFollowUp":true}

EXAMPLES (image analysis — isImageAnalysis MUST be true):
  User: "scan the images and tell me what they are" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":true}
  User: "what's in these screenshots" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":true}
  User: "describe the photos in this folder" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":true}
  User: "analyze the images in [Folder: ~/Desktop/screenshots]" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":true}
  User: "I need you to analysis this files in this folder and tell me what they're about" (folder: screenshots-for-trigger-concept-dicussion) → {"taskType":"local_file","isFollowUp":true,"followUpTarget":"/Users/lukaizhi/Desktop/screenshots-for-trigger-concept-dicussion","isImageAnalysis":true}
  User: "what do these pictures show" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":true}

EXAMPLES (NOT image analysis — isImageAnalysis MUST be false):
  User: "list the files in this folder" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":false}
  User: "copy the images to a new folder" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":false}
  User: "convert the png to jpg" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":false}
  User: "what's on my screen" → {"taskType":"query","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":false}
  User: "resize the screenshot to 800px" → {"taskType":"local_file","isFollowUp":false,"followUpTarget":null,"isImageAnalysis":false}

EXAMPLES (ambiguous file path — needsClarification MUST be true):
  User: "Open the <basename> file in <app-name> and ask the AI what it does." → {"taskType":"app_automation","targetService":"<app-name>","needsClarification":true,"reason":"file path is ambiguous: '<basename>' has no extension or folder"}
  User: "Open the readme in <app-name> and summarize it." → {"taskType":"app_automation","targetService":"<app-name>","needsClarification":true,"reason":"file path is ambiguous: 'readme' has no extension or folder"}

EXAMPLES (resolvable file path — needsClarification MUST be false):
  User: "Open <filename.ext> in <app-name> and ask the AI what it's about." → {"taskType":"app_automation","targetService":"<app-name>","needsClarification":false}
  User: "Open /Users/me/project/src/index.ts in <app-name> and refactor it." → {"taskType":"app_automation","targetService":"<app-name>","needsClarification":false}

EXAMPLES (passive screen observation — taskType MUST be "query", handled by screen_intelligence):
  User: "describe what's displayed on my screen" → {"taskType":"query","isFollowUp":false,"followUpTarget":null}
  User: "tell me what this page says" → {"taskType":"query","isFollowUp":false,"followUpTarget":null}
  User: "explain what's showing on my monitor" → {"taskType":"query","isFollowUp":false,"followUpTarget":null}
  User: "give me a summary of what's visible" → {"taskType":"query","isFollowUp":false,"followUpTarget":null}

EXAMPLES (imperative screen actions — taskType stays "local_system"):
  User: "take a screenshot" → {"taskType":"local_system","isFollowUp":false,"followUpTarget":null}
  User: "highlight the submit button on this page" → {"taskType":"local_system","isFollowUp":false,"followUpTarget":null}
  User: "scroll down on the current page" → {"taskType":"local_system","isFollowUp":false,"followUpTarget":null}

- suggestedIntent: the single-step intent this message routes to, derived FROM the fields you just set — not an independent guess:
  - taskType in {local_file, local_system, app_automation, browser, messaging, scheduling} or any interactive action → "command_automate"
  - passive screen observation (see the "query" rule) → "screen_intelligence"
  - isScreenOutput → "screen_display"
  - isConversationRecall, isActivityQuery, or an unresolved follow-up whose referent is the conversation itself → "memory_retrieve"
  - memory store ("remember/note that my X is Y") → "memory_store"
  - live/time-sensitive info needs (news, prices, "latest", weather) → "web_search"
  - timeless knowledge, math, definitions → "general_knowledge"
  - pure greeting/chitchat → "greeting"
  - 2+ truly independent goals needing separate steps → "multi_step"
  - genuinely can't tell → null

No explanation. No markdown. Only the JSON object.`;

// Extract and parse JSON from LLM output using the shared parseLlmJson utility.
const { parseLlmJson } = require('./parseLlmJson');

/**
 * deriveResolution — collapse a (possibly partial or contradictory) LLM
 * classification into the pipeline's single authoritative verdict:
 *
 *   'resolved'             — a concrete referent/target exists, or the missing
 *                            detail is a slot that downstream fillers
 *                            (gatherPlanContext/grill) already own
 *   'needs_clarification'  — the message carries no usable referent: a bare
 *                            ack with nothing to attach to, a card reply the
 *                            classifier couldn't resolve, or a hedged vague/
 *                            ambiguous turn. The clarify gate asks the user
 *                            before routing — the literal text never reaches
 *                            search, planning, or automation.
 *   'declined_ack'         — a bare refusal to a proactive card or assistant
 *                            offer. Terminal acknowledgement: never clarify,
 *                            never execute the offered action.
 *
 * This is the ONLY place the verdict is computed — downstream nodes read
 * `resolution` instead of re-interpreting the individual flags.
 */
function deriveResolution(tc, userMessage, hasAttachedCard) {
  const word = String(userMessage || '').toLowerCase().replace(/[.!?…]+/g, '').trim();
  const isDecline = BARE_DECLINE_RE.test(word);
  const isAffirm  = BARE_AFFIRM_RE.test(word);

  // A bare decline to a card/offer is a complete answer — not a task.
  if (isDecline && (hasAttachedCard || tc.isThoughtReply)) return 'declined_ack';

  // Any concrete referent → downstream nodes have something to work with.
  if (tc.followUpTarget || tc.activeDocRef || tc.isScreenFollowUp || tc.needsFreshScreen) {
    return 'resolved';
  }

  const unattachedCardAck = !!tc.isThoughtReply && (isAffirm || isDecline);
  const hedgedVague = tc.needsClarification === true
    && (tc.taskType === 'ambiguous' || tc.taskType === 'query');
  const orphanAck = isAffirm && !tc.isFollowUp;

  if (unattachedCardAck || hedgedVague || orphanAck) return 'needs_clarification';
  return 'resolved';
}

/**
 * Classify the user's task using the LLM.
 *
 * @param {string} userMessage
 * @param {Array}  conversationHistory — last N turns from resolveReferencesV2
 * @param {object} llmBackend — generateAnswer interface
 * @param {object} logger
 * @returns {Promise<object>} classification object (always resolves, never throws)
 */
// Strip overlay-injected attachment tags ([Thought: …], [File: …],
// [Folder: …], [Context: …], [Highlighted: …]) from the start of a message
// before classification — the tag text (often a long proactive outreach) can
// break the classifier's JSON response and skew taskType. The tags remain in
// the raw message for downstream planning nodes.
function _stripAttachmentTags(text) {
  let t = String(text || '');
  // Single-line tags: each occupies one line ending in ']'
  const lineTag = /^[ \t]*\[(?:Thought|File|Folder|Context|Highlighted):[^\n]*\][ \t]*\n?/;
  while (lineTag.test(t)) t = t.replace(lineTag, '');
  // Leading multi-line tag block (e.g. a multi-line [Highlighted: …]) —
  // lazy match to the first ']' is sufficient here.
  t = t.replace(/^\s*\[(?:Thought|File|Folder|Context|Highlighted):[\s\S]*?\]\s*/, '');
  return t.trim();
}

async function classifyTask(userMessage, conversationHistory, llmBackend, logger, priorScreenSummary, activeAppContext, options = {}) {
  const _default = {
    taskType: 'ambiguous',
    isFollowUp: false,
    followUpTarget: null,
    needsClarification: false,
    targetService: null,
    isRecurring: false,
    isBrowseOnly: false,
    requiresDOM: false,
    isScreenFollowUp: false,
    needsFreshScreen: false,
    isAppUiInspection: false,
    isSpatialAnalysis: false,
    isImageAnalysis: false,
    isConversationRecall: false,
    isActivityQuery: false,
    isThoughtReply: false,
    webAccessMode: 'none',
    interactiveActions: [],
    expectsFileOutput: false,
    activeDocRef: null,
    activeDocTarget: null,
    mediaListing: 'none',
    suggestedIntent: null,
    isScreenOutput: false,
    screenOutputAction: null,
    screenOutputKind: null,
    screenOutputContent: null,
    screenOutputMood: null,
    screenOutputPayload: null,
    resolution: 'resolved',
  };

  // Classify the user's actual text, not overlay-injected attachment tags.
  const classifiedMessage = _stripAttachmentTags(userMessage) || userMessage;
  const _hasAttachedCard = (conversationHistory || []).some(m => m.attachedToMessage);
  const _withResolution = (tc) => {
    tc.resolution = deriveResolution(tc, classifiedMessage, _hasAttachedCard);
    return tc;
  };

  if (!llmBackend || !userMessage) return _withResolution(_default);

  // ── Deterministic conversation-recall pre-check ────────────────────────────
  // The LLM sometimes returns isConversationRecall:false for obvious meta-questions
  // like "what did I just ask", causing answer.js to skip injecting chat history.
  // Force-override these patterns so the user gets a reliable recall response.
  // Keep the pattern narrow — only meta-questions about the chat transcript itself,
  // NOT queries about past activity/episodic memory (those are memory_retrieve).
  // Canonical pattern: CONVERSATION_RECALL_META_RE in shared/text-patterns.cjs.
  if (CONVERSATION_RECALL_META_RE.test(classifiedMessage)) {
    logger.info(`[classifyTask] Deterministic conversation-recall match: "${classifiedMessage.slice(0, 80)}"`);
    return {
      ..._default,
      taskType: 'query',
      isConversationRecall: true,
      isFollowUp: false,
      followUpTarget: null,
    };
  }

  try {
    // Keep enough context to survive a few short conversational turns between
    // a screen answer and a clarification. The classifier previously saw only
    // six messages, so a 3-turn exchange could hide the original screen answer
    // before the next clarification was classified.
    const _roleLabel = (m) => {
      if (m.isThoughtCard || m.source === 'thought-attachment') {
        return m.attachedToMessage
          ? 'Assistant (proactive card ATTACHED to the user\'s reply — it was on screen when they sent this message, and its offer/question is the live referent candidate)'
          : 'Assistant (proactive card shown to user earlier, not a spoken reply)';
      }
      return m.role === 'user' ? 'User' : 'Assistant';
    };
    const recentCtx = (conversationHistory || []).slice(-16)
      .map(m => `${_roleLabel(m)}: ${String(m.content || '').slice(0, 500)}`)
      .join('\n');

    // Cross-session semantic matches are merged into conversationHistory and
    // timestamp-sorted — they rarely land in the recent slice when the current
    // session is busy. Surface them under an explicit label so followUpTarget
    // resolution for older-session referents still works.
    const semanticCtx = (conversationHistory || [])
      .filter(m => (m.source === 'semantic' || m.source === 'semantic-result' || m.source === 'prior-session') && m.content && m.content.trim())
      .slice(-8)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 300)}`)
      .join('\n');

    const screenBlock = priorScreenSummary ? `\n\n${priorScreenSummary}` : '';
    // Active app context — the live open app + file path. The classifier uses
    // this to resolve deictic references ("this file", "it") to the actual open
    // file instead of a stale followUpTarget from conversation history.
    let activeAppBlock = '';
    if (activeAppContext && typeof activeAppContext === 'object') {
      const parts = [];
      if (activeAppContext.appName)     parts.push(`App: ${activeAppContext.appName}`);
      if (activeAppContext.windowTitle)  parts.push(`Window: "${activeAppContext.windowTitle}"`);
      if (activeAppContext.filePath)     parts.push(`File: ${activeAppContext.filePath}`);
      if (activeAppContext.url)          parts.push(`URL: ${activeAppContext.url}`);
      if (parts.length > 0) {
        activeAppBlock = `\n\nACTIVE APP CONTEXT (live): ${parts.join(', ')}`;
      }
    }
    const prompt = `RECENT CONVERSATION:\n${recentCtx || '(none)'}${semanticCtx ? `\n\nRELEVANT EARLIER MESSAGES (older sessions — use only if they resolve the current message's referent):\n${semanticCtx}` : ''}${screenBlock}${activeAppBlock}\n\nCURRENT USER MESSAGE: "${classifiedMessage}"`;

    const raw = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: { systemInstructions: options.systemPrompt || CLASSIFY_SYSTEM_PROMPT },
    }, { maxTokens: 120, temperature: 0, fastMode: true, taskType: 'classification' });

    const text = typeof raw === 'string' ? raw : (raw?.text || raw?.content || '');

    // Use the shared parseLlmJson utility — handles markdown fences, missing
    // boolean values, dangling commas, unterminated strings, and jsonrepair fallback.
    const parsed = parseLlmJson(text, logger, 'classifyTask');
    if (!parsed) {
      logger.debug('[classifyTask] No JSON in response — using default');
      return _withResolution(_default);
    }

    // Sanitize webAccessMode — only the four known values; requiresDOM forces
    // 'interactive' since DOM-level work always needs a real browser session.
    const _VALID_WEB_MODES = new Set(['none', 'download', 'public_read', 'interactive']);
    let webAccessMode = _VALID_WEB_MODES.has(parsed.webAccessMode) ? parsed.webAccessMode : 'none';
    let requiresDOM = !!parsed.requiresDOM;
    const _interactiveActions = Array.isArray(parsed.interactiveActions) ? parsed.interactiveActions : [];

    // ── Search-to-extract guard: "click/open the first result" is URL selection
    // for public read, not a DOM interaction, unless the user also wants to
    // mutate state (cart, checkout, filter, form fill, etc.).
    const _firstResultPattern = /\b(?:click|open|follow|select|tap)\s+(?:the\s+)?(?:first|top|1st)\s+(?:result|product|item|link|listing|page)\b/i;
    const _mutationActions = new Set(['add_to_cart', 'checkout', 'place_order', 'filter_ui', 'sort_ui', 'fill_form', 'submit_form', 'book_reservation', 'upload', 'publish', 'delete', 'edit', 'create', 'update', 'send_message', 'send_email', 'post', 'comment', 'like', 'share', 'follow', 'subscribe', 'retweet', 'react', 'vote', 'play_media', 'pause_media', 'skip_media', 'shuffle', 'repeat']);
    const _hasMutationAction = _interactiveActions.some(a => _mutationActions.has(a));
    const _isFirstResultExtract = _firstResultPattern.test(userMessage) && !_hasMutationAction;
    if (_isFirstResultExtract && (webAccessMode === 'interactive' || requiresDOM)) {
      logger.info(`[classifyTask] Search-to-extract first-result pattern detected — forcing public_read: "${userMessage.slice(0, 80)}"`);
      webAccessMode = 'public_read';
      requiresDOM = false;
      parsed.interactiveActions = [];
    }

    if (requiresDOM) webAccessMode = 'interactive';
    else if (parsed.taskType === 'browser' && webAccessMode === 'none') webAccessMode = 'interactive'; // fail-safe

    const parsedIsScreenFollowUp = !!parsed.isScreenFollowUp;
    const parsedIsFollowUp = !!parsed.isFollowUp;
    const parsedFollowUpTarget = parsed.followUpTarget || null;

    // Phantom-service guard: the classifier sometimes INVENTS a targetService
    // the user never named ("pull up John 3:16" → "biblegateway"), which blocks
    // the public-research guard and forces a heavyweight command_automate plan
    // for a simple lookup. For non-interactive tasks, drop any service not
    // literally mentioned in the message. Interactive tasks keep the inferred
    // target — the planner needs a service domain to drive.
    const _serviceMentioned = (svc, msg) => {
      if (!svc || !msg) return false;
      const m = msg.toLowerCase();
      const s = String(svc).toLowerCase();
      if (m.includes(s)) return true;
      // Multi-word services ("google docs") — any ≥3-char token counts
      return s.split(/[^a-z0-9]+/).filter(t => t.length >= 3).some(t => m.includes(t));
    };
    let parsedTargetService = parsed.targetService || null;
    // Follow-up replies are bare ("yes", "go ahead") — the service name lives
    // in the resolved followUpTarget (the accepted offer), not the reply
    // itself. Check both so a legitimately inherited service isn't dropped.
    const _mentionCorpus = parsedFollowUpTarget
      ? `${classifiedMessage} ${parsedFollowUpTarget}` : classifiedMessage;
    if (parsedTargetService && webAccessMode !== 'interactive' && !requiresDOM &&
        !_serviceMentioned(parsedTargetService, _mentionCorpus)) {
      logger.info(`[classifyTask] Phantom targetService "${parsedTargetService}" not mentioned in message — dropping (webAccessMode=${webAccessMode})`);
      parsedTargetService = null;
    }

    // activeDocRef — kind of live-document referent, if any. The concrete
    // target (path/url) is attached deterministically by the caller from the
    // live context — never trust an LLM-emitted path string.
    const _VALID_DOC_REFS = new Set(['file', 'url', 'screen']);
    const activeDocRef = _VALID_DOC_REFS.has(parsed.activeDocRef) ? parsed.activeDocRef : null;

    const _VALID_MEDIA_LISTINGS = new Set(['none', 'image', 'video']);

    // suggestedIntent — the single-step intent the classifier itself implies.
    // Whitelisted; invalid/missing → null (decompose falls back to the number
    // call). 'multi_step' means the message needs the full llmDecompose path.
    const _VALID_SUGGESTED_INTENTS = new Set([
      'command_automate', 'screen_intelligence', 'web_search', 'memory_store',
      'memory_retrieve', 'general_knowledge', 'greeting', 'screen_display', 'multi_step',
    ]);

    // Action/passive coherence: taskType and suggestedIntent come from the
    // same call but flake independently — "read the file /tmp/x" emitted
    // taskType:'local_file' + suggestedIntent:'general_knowledge', and the
    // merge's concur-rule then amplified the contradiction into a blind
    // text answer. Contradictory fields → drop the suggestion so the
    // decompose arbitration (number call + hint veto) decides instead.
    const _ACTION_TASK_TYPES = new Set(['local_file', 'local_system', 'app_automation', 'browser', 'messaging', 'scheduling']);
    const _PASSIVE_INTENTS = new Set(['general_knowledge', 'web_search', 'screen_intelligence', 'memory_retrieve', 'memory_store', 'greeting']);
    // A literal filesystem path is ground truth — "read the file /tmp/x.txt"
    // flaked to taskType:'query' once, letting a passive suggestedIntent carry
    // it to a "I can't read files" hallucination. Any POSIX path token in the
    // message means the task touches the filesystem; coerce a passive typing.
    if (FILE_PATH_RE.test(classifiedMessage)
        && (!parsed.taskType || parsed.taskType === 'query' || parsed.taskType === 'ambiguous')) {
      logger.info(`[classifyTask] Literal path in message but taskType='${parsed.taskType}' — coercing to local_file`);
      parsed.taskType = 'local_file';
    }

    const _rawSuggested = _VALID_SUGGESTED_INTENTS.has(parsed.suggestedIntent) ? parsed.suggestedIntent : null;
    const _contradicts = _rawSuggested && (
      (_ACTION_TASK_TYPES.has(parsed.taskType) && _PASSIVE_INTENTS.has(_rawSuggested) && _rawSuggested !== 'screen_display')
      || ((parsed.taskType === 'query' || parsed.taskType === 'ambiguous') && _rawSuggested === 'command_automate')
    );
    // screen_display exempt: it pairs with isScreenOutput, which the
    // screen-output guard re-derives lexically anyway.

    // Deterministic consistency: a resolved file/url target never needs screen
    // OCR. The LLM has emitted isScreenFollowUp:true alongside activeDocRef:"url"
    // (observed on "print this page for me") — normalize rather than trust.
    const concreteDocRef = activeDocRef === 'file' || activeDocRef === 'url';

    return _applyScreenDetect(_withResolution({
      taskType:            parsed.taskType           || _default.taskType,
      isFollowUp:          parsedIsFollowUp,
      followUpTarget:      parsedFollowUpTarget,
      needsClarification:  !!parsed.needsClarification,
      targetService:       parsedTargetService,
      isRecurring:         !!parsed.isRecurring,
      isBrowseOnly:        !!parsed.isBrowseOnly,
      requiresDOM,
      isScreenFollowUp:    concreteDocRef ? false : parsedIsScreenFollowUp,
      needsFreshScreen:    concreteDocRef ? false : !!parsed.needsFreshScreen,
      isAppUiInspection:   !!parsed.isAppUiInspection,
      isSpatialAnalysis:   !!parsed.isSpatialAnalysis,
      isImageAnalysis:     !!parsed.isImageAnalysis,
      isConversationRecall: !!parsed.isConversationRecall,
      isActivityQuery:     !!parsed.isActivityQuery,
      isThoughtReply:      !!parsed.isThoughtReply,
      webAccessMode,
      interactiveActions:  Array.isArray(parsed.interactiveActions) ? parsed.interactiveActions : [],
      expectsFileOutput:   !!parsed.expectsFileOutput,
      activeDocRef,
      activeDocTarget:     null, // resolved by caller from live context
      mediaListing:        _VALID_MEDIA_LISTINGS.has(parsed.mediaListing) ? parsed.mediaListing : 'none',
      suggestedIntent:     _contradicts ? null : _rawSuggested,
      isScreenOutput:      !!parsed.isScreenOutput,
      screenOutputAction:  ['show', 'clear'].includes(parsed.screenOutputAction) ? parsed.screenOutputAction : null,
      screenOutputKind:    ['text', 'emoji', 'image', 'chart', 'effect', 'alert', 'deck', 'scene'].includes(parsed.screenOutputKind) ? parsed.screenOutputKind : null,
      screenOutputContent: typeof parsed.screenOutputContent === 'string' && parsed.screenOutputContent ? parsed.screenOutputContent.slice(0, 20000) : null,
      screenOutputMood:    ['neutral', 'warm', 'happy', 'sad', 'alert', 'playful', 'calm'].includes(parsed.screenOutputMood) ? parsed.screenOutputMood : null,
      // Structured payload passthrough for chart/deck/alert data — bounded and
      // re-validated downstream by shared/screen-output.cjs normalization.
      screenOutputPayload: (() => {
        if (!parsed.screenOutputPayload || typeof parsed.screenOutputPayload !== 'object' || Array.isArray(parsed.screenOutputPayload)) return null;
        try {
          const s = JSON.stringify(parsed.screenOutputPayload);
          return s.length <= 51200 ? JSON.parse(s) : null;
        } catch (_) { return null; }
      })(),
    }), userMessage);
  } catch (err) {
    logger.debug(`[classifyTask] Failed (non-fatal): ${err.message} — using default`);
    return _applyScreenDetect(_withResolution(_default), userMessage);
  }
}

module.exports = { classifyTask, deriveResolution, detectScreenOutput, CLASSIFY_SYSTEM_PROMPT, _stripAttachmentTags };
