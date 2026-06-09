/**
 * Skill Thinking Helper
 * 
 * Generates human-readable thinking messages for each skill type
 * to provide visibility into what the agent is about to do.
 */

/**
 * Generate thinking message for a skill based on args
 * @param {string} skill - Skill name (e.g., 'shell.run', 'fs.read')
 * @param {Object} args - Skill arguments
 * @param {Object} context - Additional context (stepNum, totalSteps, etc.)
 * @returns {string} Human-readable thinking message
 */
function generateSkillThinking(skill, args = {}, context = {}) {
  const { stepNum, totalSteps } = context;
  const prefix = stepNum ? `[Step ${stepNum}${totalSteps ? `/${totalSteps}` : ''}] ` : '';
  
  switch(skill) {
    case 'shell.run':
      return generateShellRunThinking(args, prefix);
      
    case 'fs.read':
      return generateFsReadThinking(args, prefix);
      
    case 'fs.write':
      return generateFsWriteThinking(args, prefix);
      
    case 'image.analyze':
      return generateImageAnalyzeThinking(args, prefix);
      
    case 'browser.act':
      return generateBrowserActThinking(args, prefix);
      
    case 'browser.agent':
      return generateBrowserAgentThinking(args, prefix);
      
    case 'cli.agent':
      return generateCliAgentThinking(args, prefix);
      
    case 'system.introspect':
      return generateSystemIntrospectThinking(args, prefix);
      
    case 'web.crawl':
      return generateWebCrawlThinking(args, prefix);
      
    case 'synthesize':
      return generateSynthesizeThinking(args, prefix);
      
    case 'external.skill':
      return `${prefix}🔗 External skill: ${args.skillId || args.skill || 'unknown'}`;
      
    default:
      return `${prefix}⚙️ Preparing ${skill}...`;
  }
}

function generateShellRunThinking(args, prefix) {
  if (args.goal) {
    // Goal mode - analyzing with LLM
    const goalSummary = args.goal.length > 80 ? args.goal.slice(0, 80) + '...' : args.goal;
    return `${prefix}🔧 Analyzing: "${goalSummary}"`;
  }
  
  if (args.cmd) {
    // Direct command mode
    const cmdStr = args.argv 
      ? `${args.cmd} ${args.argv.join(' ').slice(0, 60)}`
      : args.cmd;
    return `${prefix}🔧 Executing: ${cmdStr}`;
  }
  
  return `${prefix}🔧 Preparing shell command...`;
}

function generateFsReadThinking(args, prefix) {
  const target = args.path || args.filePath || args.dir || args.directory;
  
  if (args.action === 'tree' || args.tree) {
    return `${prefix}📁 Building directory tree${target ? `: ${target}` : ''}...`;
  }
  
  if (args.action === 'list' || args.list) {
    return `${prefix}📁 Listing directory${target ? `: ${target}` : ''}...`;
  }
  
  if (target) {
    return `${prefix}📖 Reading ${args.action === 'dir' || args.recursive ? 'directory' : 'file'}: ${target}`;
  }
  
  return `${prefix}📖 Reading file system...`;
}

function generateFsWriteThinking(args, prefix) {
  const target = args.path || args.filePath;
  if (target) {
    return `${prefix}✍️ Writing to: ${target}`;
  }
  return `${prefix}✍️ Writing file...`;
}

function generateImageAnalyzeThinking(args, prefix) {
  const filePath = args.filePath || args.path || args.image;
  
  if (filePath) {
    const fileName = filePath.split('/').pop() || filePath;
    if (args.prompt) {
      const promptSummary = args.prompt.length > 50 ? args.prompt.slice(0, 50) + '...' : args.prompt;
      return `${prefix}🔍 Analyzing image "${fileName}" for: ${promptSummary}`;
    }
    return `${prefix}🔍 Analyzing image: ${fileName}`;
  }
  
  return `${prefix}🔍 Analyzing image...`;
}

function generateBrowserActThinking(args, prefix) {
  const action = args.action || 'navigate';
  const url = args.url ? ` → ${args.url.slice(0, 50)}` : '';
  
  const actionDescriptions = {
    'navigate': '🌐 Navigating to page',
    'goto': '🌐 Navigating to page',
    'open': '🌐 Opening browser',
    'click': '👆 Clicking element',
    'fill': '⌨️ Filling form field',
    'type': '⌨️ Typing text',
    'press': '⌨️ Pressing key',
    'hover': '👆 Hovering over element',
    'scroll': '📜 Scrolling page',
    'snapshot': '📸 Capturing page snapshot',
    'wait': '⏳ Waiting for condition',
    'close': '🔒 Closing browser session',
    'upload': '📤 Uploading file',
    'download': '📥 Downloading file',
    'video-start': '🎥 Starting video recording',
    'video-stop': '🎥 Stopping video recording',
    'tracing-start': '📊 Starting trace recording',
    'tracing-stop': '📊 Stopping trace recording',
  };
  
  const desc = actionDescriptions[action] || `🌐 Browser ${action}`;
  return `${prefix}${desc}${url}`;
}

function generateBrowserAgentThinking(args, prefix) {
  const agentId = args.agentId || 'browser';
  const task = args.task ? `: "${String(args.task).slice(0, 60)}"` : '';
  return `${prefix}🤖 ${agentId}${task}`;
}

function generateCliAgentThinking(args, prefix) {
  const task = args.task || args.action || 'CLI task';
  const taskSummary = task.length > 70 ? task.slice(0, 70) + '...' : task;
  return `${prefix}💻 ${taskSummary}`;
}

function generateSystemIntrospectThinking(args, prefix) {
  const query = args.query || args.question || 'system information';
  return `${prefix}🔍 Querying: ${query}`;
}

function generateWebCrawlThinking(args, prefix) {
  const url = args.url || args.startUrl;
  if (url) {
    return `${prefix}🕷️ Crawling: ${url.slice(0, 60)}`;
  }
  return `${prefix}🕷️ Web crawling...`;
}

function generateSynthesizeThinking(args, prefix) {
  if (args.prompt) {
    const promptSummary = args.prompt.length > 70 ? args.prompt.slice(0, 70) + '...' : args.prompt;
    return `${prefix}🧠 Synthesizing: ${promptSummary}`;
  }
  return `${prefix}🧠 Synthesizing results...`;
}

module.exports = {
  generateSkillThinking,
};
