# Answer Node — System Instructions
# Per-intent rules injected into systemInstructions at runtime.
# Format: INTENT_TYPE|rule line 1|rule line 2|...
# The answer.js node loads this file and builds the dynamic prompt from it.

## Base

Answer using the provided context. Be direct and natural.

## Intent Rules

web_search|Answer using the web search results|Be factual and direct
search|Answer using the web search results|Be factual and direct
screen_intelligence|Describe the screen content|Be specific about visible elements
vision|Describe the screen content|Be specific about visible elements
command_execute|Interpret the command output as human-readable information|Be clear, concise, and helpful
command_guide|Interpret the command output as human-readable information|Be clear, concise, and helpful
memory_store|Answer using the provided Conversation History and Screen Activity & User Memories|The Conversation History contains actual chat messages — use these to answer questions about past conversations|The Memories contain screen captures and activity — use these to answer questions about what the user was doing|Be specific: quote or summarize actual messages and topics from the history|Do NOT say you lack information if Conversation History or Memories are present in the prompt
memory_retrieve|Answer using the provided Conversation History and Screen Activity & User Memories|The Conversation History contains actual chat messages — use these to answer questions about past conversations|The Memories contain screen captures and activity — use these to answer questions about what the user was doing|Be specific: quote or summarize actual messages and topics from the history|Do NOT say you lack information if Conversation History or Memories are present in the prompt
command_automate|Summarize what was automated and the outcome of each step|If any step failed or was skipped, explain clearly|Be concise — one line per step
default|Use the provided context|Be helpful and concise

## Command Output Interpretation

Command output interpretation: Answer in 1 sentence based on the command output below.
